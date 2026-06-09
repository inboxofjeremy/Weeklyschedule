/**
 * build.js — Stremio static catalog (TVMaze schedule + TMDB ID merge)
 */

import fs from "fs";
import path from "path";

const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const OUT_DIR = "./";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");
const DAYS_BACK = 10;
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
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

const cleanHTML = s => s ? s.replace(/<[^>]+>/g, "").trim() : "";

function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  return `${parts.find(p => p.type === "year").value}-${parts.find(p => p.type === "month").value}-${parts.find(p => p.type === "day").value}`;
}

function getStrictEpisodeDate(ep) { return ep?.airdate || ep?.airstamp?.slice(0, 10) || null; }

function isInWindow(epDate, showName) {
  if (!epDate) return false;
  const todayStr = pacificDateString(new Date());
  const today = new Date(todayStr + "T00:00:00Z");
  const start = new Date(today);
  start.setDate(start.getDate() - (DAYS_BACK - 1));
  const ep = new Date(epDate + "T00:00:00Z");
  
  const inWindow = ep >= start && ep <= today;
  
  if (showName?.toLowerCase().includes("blankety")) {
    console.log(`[DATE DEBUG] ${showName} | EP: ${epDate} | Range: ${start.toISOString().slice(0,10)} to ${today.toISOString().slice(0,10)} | InWindow: ${inWindow}`);
  }
  
  return inWindow;
}

// =======================
// FILTERS
// =======================
function isSports(show) { return (show.type || "").toLowerCase() === "sports" || (show.genres || []).some(g => g?.toLowerCase() === "sports"); }
function isNews(show) {
  const t = (show.type || "").toLowerCase();
  const genres = (show.genres || []).map(g => g.toLowerCase());
  if (genres.includes("panel") || genres.includes("quiz") || genres.includes("game show")) return false;
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

function isExcluded(show) {
  const checks = [
    { name: "Sports", fn: isSports }, { name: "News", fn: isNews }, { name: "Foreign", fn: isForeign },
    { name: "BlockedWeb", fn: isBlockedWebChannel }, { name: "YouTube", fn: isYouTubeShow },
    { name: "Documentary", fn: isDocumentary }, { name: "BlockedPlatform", fn: isBlockedPlatform },
    { name: "Legal", fn: isLegal }, { name: "Language", fn: isBlockedLanguage }
  ];
  for (const check of checks) {
    if (check.fn(show)) {
      if (show.name?.toLowerCase().includes("blankety")) console.log(`[DEBUG] BLOCKED "${show.name}" by: ${check.name}`);
      return true;
    }
  }
  return false;
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
  const best = search.results.sort((a, b) => new Date(b.first_air_date || 0) - new Date(a.first_air_date || 0))[0];
  return best?.id || null;
}

async function build() {
  const showMap = new Map();
  console.log("=== BUILD START ===");

  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);
    console.log(`[QUERY] Date: ${dateStr}`);

    for (const url of [`https://api.tvmaze.com/schedule?country=US&date=${dateStr}`, `https://api.tvmaze.com/schedule/web?date=${dateStr}`, `https://api.tvmaze.com/schedule/full?date=${dateStr}`]) {
      const list = await fetchJSON(url);
      if (!Array.isArray(list)) continue;
      
      for (const ep of list) {
        const show = ep.show || ep._embedded?.show;
        if (!show?.id) continue;
        
        if (show.name?.toLowerCase().includes("blankety")) {
            console.log(`[DEBUG] Found in API: ${show.name} at ${url}`);
        }
        
        if (isExcluded(show)) continue;
        
        const epDate = getStrictEpisodeDate(ep);
        if (isInWindow(epDate, show.name)) {
            if (!showMap.has(show.id)) showMap.set(show.id, { show, episodes: [] });
            showMap.get(show.id).episodes.push(ep);
        }
      }
    }
  }

  console.log(`[INFO] Shows collected: ${showMap.size}`);
  const metas = [];
  for (const entry of showMap.values()) {
    const tmdbId = await findTmdbId(entry.show);
    const stremioId = tmdbId ? `tmdb:${tmdbId}` : `tmdb:${900000000 + entry.show.id}`;
    metas.push({
      id: stremioId, type: "series", name: entry.show.name,
      videos: entry.episodes.map(ep => ({ id: `${stremioId}:${ep.season}:${ep.number}`, title: ep.name }))
    });
  }
  
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"), JSON.stringify({ metas }, null, 2));
  console.log("=== BUILD COMPLETE ===");
}

build().catch(err => { console.error(err); process.exit(1); });
