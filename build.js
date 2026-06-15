/**
 * build.js — Stremio static catalog
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";

// Ensure paths are absolute based on the script location
const CATALOG_DIR = path.join(__dirname, "catalog", "series");
const DAYS_BACK = 9;
const TVMAZE_DELAY_MS = 150;
let lastTvmazeCall = 0;

const TMDB_OVERRIDES = {};

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

function getLatestDate(show) {
  const dates = (show.videos || [])
    .map(v => v.released)
    .filter(d => d && typeof d === 'string' && d.includes('-'));
  return dates.length > 0 ? dates.sort().reverse()[0] : "0000-00-00";
}

function isExcluded(show) {
  // (Your existing isExcluded logic)
  const name = (show.name || "").toLowerCase();
  const t = (show.type || "").toLowerCase();
  const genres = (show.genres || []).map(g => g.toLowerCase());
  const lang = (show.language || "").toLowerCase();
  const webChannel = (show.webChannel?.name || "").toLowerCase();
  const network = (show.network?.name || "").toLowerCase();

  if (name.includes("blankety blank")) return false;
  const blockedNetworks = ["iqiyi", "bilibili", "wavve", "youku", "tencent qq", "vivaone", "premier", "смотрим", "кион", "geo entertainment", "tokyo mx"];
  if (blockedNetworks.includes(webChannel) || blockedNetworks.includes(network)) return true;
  const blockedLanguages = ["chinese", "japanese", "russian", "mandarin", "cantonese", "korean", "hindi", "thai", "spanish", "norwegian", "hungarian", "dutch", "swedish", "portuguese", "urdu", "turkish", "hebrew"];
  if (blockedLanguages.includes(lang)) return true;
  const allowedGenres = ["panel", "quiz", "game show", "game-show", "reality"];
  if (genres.some(g => allowedGenres.includes(g)) || t === "reality") return false;
  const isSports = t === "sports" || genres.includes("sports");
  const isNews = t === "news" || t === "talk show" || genres.includes("news");
  const isDoc = t === "documentary" || genres.includes("documentary");
  return isSports || isNews || isDoc;
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
  const best = matches.length > 0 ? matches[0] : search.results[0];
  return best?.id || null;
}

async function build() {
  const activeShowIds = new Set();
  const countries = ["US", "GB", "CA", "AU", "NZ"];
  
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);
    for (const country of countries) {
      const list = await fetchJSON(`https://api.tvmaze.com/schedule?country=${country}&date=${dateStr}`);
      if (Array.isArray(list)) list.forEach(ep => {
        const show = ep.show || ep._embedded?.show;
        if (show?.id && !isExcluded(show)) activeShowIds.add(show.id);
      });
    }
  }

  const metas = [];
  for (const showId of activeShowIds) {
    const showData = await fetchJSON(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);
    if (!showData || isExcluded(showData)) continue;

    const tmdbId = TMDB_OVERRIDES[showData.id] || await findTmdbId(showData);
    const stremioId = tmdbId ? `tmdb:${tmdbId}` : `tmdb:${900000000 + showData.id}`;

    metas.push({
      id: stremioId,
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

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DAYS_BACK);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];

  const filteredMetas = metas
    .filter(show => getLatestDate(show) >= cutoffStr)
    .sort((a, b) => getLatestDate(b).localeCompare(getLatestDate(a)));

  // Ensure directory exists
  if (!fs.existsSync(CATALOG_DIR)) fs.mkdirSync(CATALOG_DIR, { recursive: true });
  
  // Write file
  const filePath = path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json");
  fs.writeFileSync(filePath, JSON.stringify({ metas: filteredMetas }, null, 2));
  console.log(`=== BUILD COMPLETE: Written to ${filePath} ===`);
}

build().catch(err => { console.error(err); process.exit(1); });
