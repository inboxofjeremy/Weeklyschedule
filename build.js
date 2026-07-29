/**
 * build.js — Stremio static catalog
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = process.env.TMDB_API_KEY;

const CATALOG_DIR = path.join(__dirname, "catalog", "series");
const DISCOVERY_DAYS_BACK = 12; 
const RETENTION_DAYS_BACK = 9; // Only include shows with episodes aired within this window

// =================================================================================
// STATIC OVERRIDES: Optional fallback map (rarely needed now)
// =================================================================================
const TMDB_ID_OVERRIDES = {
  55238: 136009, 
};

const TVMAZE_DELAY_MS = 250; 
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
  if (
    genres.some(g => allowedGenres.includes(g)) || 
    t === "reality" || 
    name.includes("zombie") || 
    name.includes("beach")
  ) {
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
  if (TMDB_ID_OVERRIDES[show.id]) {
    return TMDB_ID_OVERRIDES[show.id];
  }

  const normalizeTitle = str => (str || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
  const targetNormalized = normalizeTitle(show.name);
  
  // Search TMDB purely by title to find all candidate versions dynamically
  const search = await fetchJSON(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(show.name)}`);
  if (!search?.results?.length) return null;

  const matchingResults = search.results.filter(r => normalizeTitle(r.name) === targetNormalized);
  if (matchingResults.length === 0) return search.results[0].id;

  const tvmazeEpisodes = show._embedded?.episodes || [];
  let earliestEp = "0000-01-01";
  let latestEp = "9999-12-31";
  if (tvmazeEpisodes.length > 0) {
    const dates = tvmazeEpisodes.map(e => e.airdate || (e.airstamp ? e.airstamp.split('T')[0] : null)).filter(Boolean).sort();
    if (dates.length > 0) {
      earliestEp = dates[0];
      latestEp = dates[dates.length - 1];
    }
  }

  // Fetch detailed info for all matching TMDB candidates to evaluate status and air dates dynamically
  const scoredCandidates = [];
  for (const candidate of matchingResults) {
    const detailed = await fetchJSON(`https://api.themoviedb.org/3/tv/${candidate.id}?api_key=${TMDB_API_KEY}`);
    if (!detailed) continue;

    const status = (detailed.status || "").toLowerCase();
    const tmdbStart = detailed.first_air_date || "0000-01-01";
    const tmdbEnd = detailed.last_air_date || pacificDateString(new Date());

    let score = 0;
    // Prioritize shows that are currently returning or in production
    if (status.includes("returning") || status.includes("in production")) {
      score += 100;
    }
    // Prioritize shows whose broadcast window overlaps with the TVMaze episode dates
    if (earliestEp <= tmdbEnd && latestEp >= tmdbStart) {
      score += 50;
    }
    // Bonus for more recent last air date
    score += (new Date(tmdbEnd).getTime() / 1000000000);

    scoredCandidates.push({ id: candidate.id, score });
  }

  if (scoredCandidates.length > 0) {
    scoredCandidates.sort((a, b) => b.score - a.score);
    return scoredCandidates[0].id;
  }

  return matchingResults[0].id;
}

async function build() {
  const activeShowIds = new Set();
  const targetCountries = ["US", "GB", "CA", "AU", "NZ"];
  
  console.log(`Starting structural cross-feed schedule analysis...`);

  for (let i = 0; i < DISCOVERY_DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);
    
    for (const country of targetCountries) {
      const broadcastList = await fetchJSON(`https://api.tvmaze.com/schedule?country=${country}&date=${dateStr}`);
      if (Array.isArray(broadcastList)) {
        broadcastList.forEach(ep => {
          const show = ep.show || (ep._embedded && ep._embedded.show);
          if (show?.id) activeShowIds.add(show.id);
        });
      }
    }

    const webList = await fetchJSON(`https://api.tvmaze.com/schedule/web?date=${dateStr}`);
    if (Array.isArray(webList)) {
      webList.forEach(ep => {
        const show = ep.show || (ep._embedded && ep._embedded.show);
        if (!show?.id) return;

        const webCountry = show.webChannel?.country?.code;
        const networkCountry = show.network?.country?.code;

        if (
          (webCountry && targetCountries.includes(webCountry)) || 
          (show.webChannel && !webCountry) || 
          (!networkCountry && !show.webChannel)
        ) {
          activeShowIds.add(show.id);
        }
      });
    }
  }

  console.log(`Processing metadata mappings for ${activeShowIds.size} shows...`);

  const metas = [];
  for (const showId of activeShowIds) {
    const showData = await fetchJSON(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);
    
    if (!showData) {
      console.warn(`[API ERROR] Empty response for TVMaze ID ${showId}. Likely hit a 429 rate limit or network drop.`);
      auditLogs.push({ 
        name: `ID: ${showId}`, 
        type: "UNKNOWN", 
        status: "API FETCH FAILED", 
        detail: "TVMaze request returned null. Check network or connection throttles." 
      });
      continue;
    }

    const audit = evaluateExclusion(showData);
    if (audit.exclude) {
      auditLogs.push({ name: showData.name, type: showData.type, status: "DROPPED BY FILTER", detail: audit.reason });
      continue;
    }
    
    const tmdbId = await findTmdbId(showData);

    let stremioId = tmdbId ? `tmdb:${tmdbId}` : `tvmaze:${showData.id}`;
    if (tmdbId === 0) {
      stremioId = `tvmaze:${showData.id}`;
    }

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
        .map(ep => {
          const sNum = ep.season || 1;
          const eNum = ep.number || 0;
          const epAirDate = ep.airdate || (ep.airstamp ? ep.airstamp.split('T')[0] : null);
          const launchYear = showData.premiered ? showData.premiered.split("-")[0] : "2026";
          
          const structuralNamespace = stremioId && !stremioId.includes('null') ? stremioId : `tvmaze:${showData.id}`;
          const videoId = `${structuralNamespace}:${sNum}:${eNum}`;

          const fallbackString = `${showData.name} S${String(sNum).padStart(2, '0')}E${String(eNum).padStart(2, '0')}`;

          return {
            id: videoId,
            title: ep.name || `Episode ${eNum}`,
            season: sNum,
            episode: eNum,
            released: epAirDate,
            overview: cleanHTML(ep.summary || ""),
            
            name: fallbackString,
            series: showData.name,
            fallback_title: fallbackString,
            fallback_name: fallbackString,
            episode_name: ep.name || `Episode ${eNum}`,
            
            g_title: showData.name,
            g_year: launchYear,
            g_season: sNum,
            g_episode: eNum
          };
        })
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
  console.log("                    FINAL PIPELINE PROCESSING SUMMARY REPORT                     ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
}

build().catch(err => { console.error(err); process.exit(1); });
