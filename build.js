/**
 * build.js — Stremio static catalog
 */

import fs from "fs";
import path from "path";

const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const OUT_DIR = "./";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");
const DAYS_BACK = 9;
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

// =======================
// FILTERS
// =======================
function isExcluded(show) {
  const t = (show.type || "").toLowerCase();
  const genres = (show.genres || []).map(g => g.toLowerCase());
  const lang = (show.language || "").toLowerCase();

  // 1. WHITESLIST: Always allow these regardless of other tags
  const allowedGenres = ["panel", "quiz", "game show", "game-show", "reality"];
  if (genres.some(g => allowedGenres.includes(g)) || t === "reality") {
    return false; 
  }

  // 2. LANGUAGE FILTER: Block non-English (add others if needed)
  if (lang && lang !== "english") return true;

  // 3. BLOCKLIST: Defined strictly
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
  const best = search.results.sort((a, b) => new Date(b.first_air_date || 0) - new Date(a.first_air_date || 0))[0];
  return best?.id || null;
}

async function build() {
  const activeShowIds = new Set();
  console.log("=== BUILD START: Discovery Phase ===");

  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);
    
    for (const url of [`https://api.tvmaze.com/schedule?country=US&date=${dateStr}`, `https://api.tvmaze.com/schedule/web?date=${dateStr}`]) {
      const list = await fetchJSON(url);
      if (!Array.isArray(list)) continue;
      for (const ep of list) {
        const show = ep.show || ep._embedded?.show;
        if (show?.id && !isExcluded(show)) {
          activeShowIds.add(show.id);
        }
      }
    }
  }

  console.log(`[INFO] Identified ${activeShowIds.size} active shows. Fetching details...`);
  
  const metas = [];
  for (const showId of activeShowIds) {
    const showData = await fetchJSON(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);
    if (!showData) continue;

    const tmdbId = await findTmdbId(showData);
    const stremioId = tmdbId ? `tmdb:${tmdbId}` : `tmdb:${900000000 + showData.id}`;

    metas.push({
      id: stremioId,
      type: "series",
      name: showData.name,
      description: cleanHTML(showData.summary),
      poster: showData.image?.original || showData.image?.medium || null,
      background: showData.image?.original || null,
      videos: (showData._embedded?.episodes || []).map(ep => ({
        id: `${stremioId}:${ep.season || 0}:${ep.number || 0}`,
        title: ep.name || `Episode ${ep.number || 0}`,
        season: ep.season || 0,
        episode: ep.number || 0,
        released: ep.airdate || ep.airstamp?.slice(0, 10) || null,
        overview: cleanHTML(ep.summary || "")
      }))
    });
  }

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"), JSON.stringify({ metas }, null, 2));
  console.log("=== BUILD COMPLETE ===");
}

build().catch(err => { console.error(err); process.exit(1); });
