/**
 * build.js — Stremio static catalog
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";

const CATALOG_DIR = path.join(__dirname, "catalog", "series");
const DISCOVERY_DAYS_BACK = 12; 
const RETENTION_DAYS_BACK = 9;

const TVMAZE_DELAY_MS = 150;
let lastTvmazeCall = 0;

const auditLogs = [];

async function fetchJSON(url) {
  try {
    if (url.includes("api.tvmaze.com")) {
      const wait = Math.max(0, TVMAZE_DELAY_MS - (Date.now() - lastTvmazeCall));
      if (wait) await new Promise(r => setTimeout(r, wait));
      lastTvmazeCall = Date.now();
    }
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

const cleanHTML = s => s ? s.replace(/<[^>]+>/g, "").trim() : "";

function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

function getLatestValidDate(show, todayStr) {
  let maxDate = "0000-00-00";
  if (!show.videos) return maxDate;
  
  for (let i = 0; i < show.videos.length; i++) {
    const d = show.videos[i].released;
    if (d && typeof d === 'string' && d.includes('-') && d <= todayStr) {
      if (d > maxDate) {
        maxDate = d;
      }
    }
  }
  return maxDate;
}

function evaluateExclusion(show) {
  const name = (show.name || "").toLowerCase();
  const t = (show.type || "").toLowerCase();
  const genres = (show.genres || []).map(g => g.toLowerCase());
  const lang = (show.language || "").toLowerCase();
  const webChannel = (show.webChannel?.name || "").toLowerCase();
  const network = (show.network?.name || "").toLowerCase();

  if (name.includes("blankety blank")) return { exclude: false, reason: "Whitelisted" };

  const blockedNetworks = ["iqiyi", "bilibili", "wavve", "youku", "tencent qq", "vivaone", "premier", "смотрим", "кион", "geo entertainment", "tokyo mx"];
  if (blockedNetworks.includes(webChannel) || blockedNetworks.includes(network)) {
    return { exclude: true, reason: `Blocked Network (${webChannel || network})` };
  }
  
  const blockedLanguages = ["chinese", "japanese", "russian", "mandarin", "cantonese", "korean", "hindi", "thai", "spanish", "norwegian", "hungarian", "dutch", "swedish", "portuguese", "urdu", "turkish", "hebrew"];
  if (blockedLanguages.includes(lang)) {
    return { exclude: true, reason: `Blocked Language (${lang})` };
  }
  
  const allowedGenres = ["panel", "quiz", "game show", "game-show", "reality", "home improvement", "renovation"];
  if (genres.some(g => allowedGenres.includes(g)) || t === "reality" || name.includes("zombie")) {
    return { exclude: false, reason: "Allowed Reality/Renovation Content" };
  }
  
  if (t === "sports" || genres.includes("sports")) return { exclude: true, reason: "Excluded: Sports" };
  if (t === "news" || t === "talk show" || genres.includes("news")) return { exclude: true, reason: "Excluded: News/Talk" };
  if (t === "documentary" || genres.includes("documentary")) {
    return { exclude: true, reason: "Excluded: Pure Documentary" };
  }
  
  return { exclude: false, reason: "Passed general rules" };
}

async function findTmdbId(show) {
  let imdb = show?.externals?.imdb;
  if (!imdb) {
    const full = await fetchJSON(`https://api.tvmaze.com/shows/${show.id}`);
    imdb = full?.externals?.imdb;
  }
  if (imdb) {
    const data = await fetchJSON(`https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
    if (data?.tv_results?.length) return data.tv_results[0].id;
  }
  const search = await fetchJSON(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(show.name)}`);
  if (!search?.results?.length) return null;
  const matches = search.results.filter(r => r.name.toLowerCase() === show.name.toLowerCase());
  return matches.length > 0 ? matches[0].id : search.results[0].id;
}

async function build() {
  const activeShowIds = new Set();
  const targetCountries = ["US", "GB", "CA", "AU", "NZ"];
  
  console.log("Beginning deep cross-feed schedule analysis...");

  for (let i = 0; i < DISCOVERY_DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);
    
    // 1. Fetch the full master schedule for the day (Includes broadcast and domestic web streaming)
    const list = await fetchJSON(`https://api.tvmaze.com/schedule?date=${dateStr}`);
    
    if (Array.isArray(list)) {
      list.forEach(ep => {
        const show = ep.show || (ep._embedded && ep._embedded.show);
        if (!show?.id) return;

        // Extract regional identification strings safely
        const networkCountry = show.network?.country?.code;
        const webCountry = show.webChannel?.country?.code;

        // Identify if it matches your target regions, or if it is a global streaming asset (null)
        const isTargetNetwork = networkCountry && targetCountries.includes(networkCountry);
        const isTargetWeb = webCountry && targetCountries.includes(webCountry);
        const isGlobalWeb = !networkCountry && !webCountry; // Captures platforms with country: null

        if (isTargetNetwork || isTargetWeb || isGlobalWeb) {
          activeShowIds.add(show.id);
        }
      });
    }
  }

  const metas = [];
  for (const showId of activeShowIds) {
    const showData = await fetchJSON(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);
    if (!showData) continue;

    const audit = evaluateExclusion(showData);
    if (audit.exclude) {
      auditLogs.push({ name: showData.name, type: showData.type, status: "DROPPED BY FILTER", detail: audit.reason });
      continue;
    }

    const tmdbId = await findTmdbId(showData);
    const stremioId = tmdbId ? `tmdb:${tmdbId}` : `tvmaze:${showData.id}`;

    metas.push({
      id: stremioId,
      tvmazeId: showData.id,
      type: "series",
      name: showData.name,
      description: cleanHTML(showData.summary),
      poster: showData.image?.original || showData.image?.medium || null,
      background: showData.image?.original || null,
      videos: (showData._embedded?.episodes || [])
        .sort((a, b) => (a.season - b.season) || (a.number - b.number))
        .map(ep => ({
          id: `${stremioId}:${ep.season || 0}:${ep.number || 0}`,
          title: ep.name || `Episode ${ep.number || 0}`,
          season: ep.season || 0,
          episode: ep.number || 0,
          released: ep.airdate || (ep.airstamp ? ep.airstamp.split('T')[0] : null),
          overview: cleanHTML(ep.summary || "")
        }))
    });
  }

  const todayStr = pacificDateString(new Date());
  const cutoffTarget = new Date();
  cutoffTarget.setDate(cutoffTarget.getDate() - RETENTION_DAYS_BACK);
  const cutoffStr = pacificDateString(cutoffTarget);

  const filteredMetas = metas.filter(show => {
    const latest = getLatestValidDate(show, todayStr);
    const isKeep = latest >= cutoffStr && latest <= todayStr;
    
    if (isKeep) {
      auditLogs.push({ name: show.name, type: "Series/Reality", status: "KEPT", detail: `Latest airdate: ${latest}` });
    } else {
      auditLogs.push({ name: show.name, type: "Series/Reality", status: "DROPPED BY DATE", detail: `Airdate ${latest} falls outside retention window` });
    }
    return isKeep;
  });

  const uniqueMetasMap = new Map();
  filteredMetas.forEach(show => {
    if (uniqueMetasMap.has(show.id)) {
      show.id = `tvmaze-fallback:${show.tvmazeId}`;
    }
    uniqueMetasMap.set(show.id, show);
  });

  const finalMetas = Array.from(uniqueMetasMap.values());
  finalMetas.sort((a, b) => getLatestValidDate(b, todayStr).localeCompare(getLatestValidDate(a, todayStr)));

  if (!fs.existsSync(CATALOG_DIR)) fs.mkdirSync(CATALOG_DIR, { recursive: true });
  const filePath = path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json");
  fs.writeFileSync(filePath, JSON.stringify({ metas: finalMetas }, null, 2));

  console.log("\n=================================================================================");
  console.log("                    FINAL PIPELINE PROCESSING SUMMARY REPORT                      ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
}

build().catch(err => { console.error(err); process.exit(1); });
