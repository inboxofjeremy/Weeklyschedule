/**
 * build.js — Stremio static catalog (TVMaze schedule + TMDB ID merge)
 * GitHub Pages ONLY
 */

import fs from "fs";
import path from "path";

// =======================
// CONFIG
// =======================
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const OUT_DIR = "./";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");
const DAYS_BACK = 10;

// =======================
// TVMAZE RATE LIMIT
// =======================
const TVMAZE_DELAY_MS = 150;
let lastTvmazeCall = 0;

async function fetchJSON(url) {
  try {
    if (url.includes("api.tvmaze.com")) {
      const wait = Math.max(0, TVMAZE_DELAY_MS - (Date.now() - lastTvmazeCall));
      if (wait) await new Promise(r => setTimeout(r, wait));
      lastTvmazeCall = Date.now();
    }
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// =======================
// HELPERS
// =======================
const cleanHTML = s => s ? s.replace(/<[^>]+>/g, "").trim() : "";

function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  return `${parts.find(p => p.type === "year").value}-${parts.find(p => p.type === "month").value}-${parts.find(p => p.type === "day").value}`;
}

function getStrictEpisodeDate(ep) {
  return ep?.airdate || ep?.airstamp?.slice(0, 10) || null;
}

function isInWindow(epDate) {
  if (!epDate) return false;
  const todayStr = pacificDateString(new Date());
  const today = new Date(todayStr + "T00:00:00Z");
  const start = new Date(today);
  start.setDate(start.getDate() - (DAYS_BACK - 1));
  const ep = new Date(epDate + "T00:00:00Z");
  return ep >= start && ep <= today;
}

// =======================
// FILTERS
// =======================
function isSports(show) {
  return (show.type || "").toLowerCase() === "sports" || (show.genres || []).some(g => g?.toLowerCase() === "sports");
}

function isNews(show) {
  const t = (show.type || "").toLowerCase();
  const genres = (show.genres || []).map(g => g.toLowerCase());
  const isPanelOrGame = genres.includes("panel") || genres.includes("quiz") || genres.includes("game show");
  
  if (isPanelOrGame) return false;
  return t === "news" || t === "talk show";
}

function isForeign(show) {
  const allowed = ["US", "GB", "CA", "AU", "IE", "NZ"];
  const c = show?.network?.country?.code || show?.webChannel?.country?.code;
  if (!c) return false;
  return !allowed.includes(c.toUpperCase());
}

function isBlockedWebChannel(show) { return (show?.webChannel?.name || "").toLowerCase() === "iqiyi"; }
function isYouTubeShow(show) { return (show?.webChannel?.name || "").toLowerCase().includes("youtube"); }
function isDocumentary(show) { return (show.type || "").toLowerCase() === "documentary" || (show.genres || []).some(g => g?.toLowerCase() === "documentary"); }
function isBlockedPlatform(show) { return (show?.webChannel?.name || "").toLowerCase() === "tubi"; }
function isLegal(show) { return (show.genres || []).some(g => g?.toLowerCase() === "legal"); }
function isBlockedLanguage(show) {
  const blocked = ["italian","turkish","indonesian","spanish","thai","arabic","norwegian","german","chinese","korean","french","hindi"];
  return blocked.includes(String(show?.language || "").toLowerCase());
}

// =======================
// DEBUGGED EXCLUSION
// =======================
function isExcluded(show) {
  const checks = [
    { name: "Sports", fn: isSports },
    { name: "News", fn: isNews },
    { name: "Foreign", fn: isForeign },
    { name: "BlockedWeb", fn: isBlockedWebChannel },
    { name: "YouTube", fn: isYouTubeShow },
    { name: "Documentary", fn: isDocumentary },
    { name: "BlockedPlatform", fn: isBlockedPlatform },
    { name: "Legal", fn: isLegal },
    { name: "Language", fn: isBlockedLanguage }
  ];

  for (const check of checks) {
    if (check.fn(show)) {
      if (show.name?.toLowerCase().includes("blankety")) {
        console.log(`[DEBUG] Blocked "${show.name}" by: ${check.name}`);
      }
      return true;
    }
  }
  return false;
}

// =======================
// TMDB FIX
// =======================
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
  const results = search.results;
  let best = results.find(r => (r.first_air_date || "").startsWith("20")) || null;
  if (!best) {
    const exact = results.filter(r => (r.name || "").toLowerCase() === show.name.toLowerCase()).sort((a, b) => new Date(b.first_air_date || 0) - new Date(a.first_air_date || 0));
    best = exact[0];
  }
  if (!best) best = results.sort((a, b) => new Date(b.first_air_date || 0) - new Date(a.first_air_date || 0))[0];
  return best?.id || null;
}

// =======================
// MAIN BUILD
// =======================
async function build() {
  const showMap = new Map();
  console.log("=== BUILD START ===");

  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);
    for (const url of [`https://api.tvmaze.com/schedule?country=US&date=${dateStr}`, `https://api.tvmaze.com/schedule/web?date=${dateStr}`, `https://api.tvmaze.com/schedule/full?date=${dateStr}`]) {
      const list = await fetchJSON(url);
      if (!Array.isArray(list)) continue;
      for (const ep of list) {
        const show = ep.show || ep._embedded?.show;
        if (!show?.id || isExcluded(show)) continue;
        if (!showMap.has(show.id)) showMap.set(show.id, { show, episodes: [] });
        const entry = showMap.get(show.id);
        const epDate = getStrictEpisodeDate(ep);
        if (epDate && isInWindow(epDate)) entry.episodes.push(ep);
      }
    }
  }

  const metas = [];
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  for (const entry of showMap.values()) {
    if (!entry.episodes.length) continue;
    const show = entry.show;
    const tmdbId = await findTmdbId(show);
    const stremioId = tmdbId ? `tmdb:${tmdbId}` : `tmdb:${900000000 + show.id}`;
    metas.push({
      id: stremioId, type: "series", name: show.name, description: cleanHTML(show.summary),
      poster: show.image?.original || show.image?.medium || null, background: show.image?.original || null,
      videos: entry.episodes.map(ep => ({
        id: `${stremioId}:${ep.season || 0}:${ep.number || 0}`, title: ep.name || `Episode ${ep.number || 0}`,
        season: ep.season || 0, episode: ep.number || 0, released: ep.airdate || ep.airstamp?.slice(0, 10) || null,
        overview: cleanHTML(ep.summary || "")
      }))
    });
  }
  console.log("\nBuild complete:", metas.length);
  fs.writeFileSync(path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"), JSON.stringify({ metas }, null, 2));
}

build().catch(err => { console.error(err); process.exit(1); });
