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
  return `${parts.find(p => p.type === "year").value}-${parts.find(p => p.month === "month")?.value || parts.find(p => p.type === "month").value}-${parts.find(p => p.type === "day").value}`;
}

// =======================
// FILTERS
// =======================
function isExcluded(show) {
  const name = (show.name || "").toLowerCase();
  const t = (show.type || "").toLowerCase();
  const genres = (show.genres || []).map(g => g.toLowerCase());
  const lang = (show.language || "").toLowerCase();
  const webChannel = (show.webChannel?.name || "").toLowerCase();
  const network = (show.network?.name || "").toLowerCase();

  // 1. FORCE INCLUDE: Keep your specific show
  if (name.includes("blankety blank")) return false;

  // 2. EXPLICIT BLOCKLIST: Platforms and Languages
  const blockedWebChannels = [
      "iqiyi", "bilibili", "wavve", "youku", "tencent qq", "vivaone"
  ];
  if (blockedWebChannels.includes(webChannel) || blockedWebChannels.includes(network)) {
    console.log(`[FILTERED] "${show.name}" (Blocked WebChannel/Network)`);
    return true;
  }
  
  const blockedLanguages = [
    "chinese", "japanese", "russian", "mandarin", "cantonese", 
    "korean", "hindi", "thai", "spanish", "norwegian"
  ];
  if (blockedLanguages.includes(lang)) {
    console.log(`[FILTERED] "${show.name}" (Blocked Language: ${lang})`);
    return true;
  }

  // 3. WHITESLIST: Allow your preferred genres
  const allowedGenres = ["panel", "quiz", "game show", "game-show", "reality"];
  if (genres.some(g => allowedGenres.includes(g)) || t === "reality") return false;

  // 4. BLOCKLIST (General)
  const isSports = t === "sports" || genres.includes("sports");
  const isNews = t === "news" || t === "talk show" || genres.includes("news");
  const isDoc = t === "documentary" || genres.includes("documentary");

  if (isSports || isNews || isDoc) {
    console.log(`[FILTERED] "${show.name}" (Type/Genre block)`);
    return true;
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
  const activeShowIds = new Set();
  const countries = ["US", "GB", "CA", "AU", "NZ"];
  
  console.log("=== BUILD START: Discovery Phase ===");

  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);
    console.log(`[QUERY] Scanning date: ${dateStr}`);
    
    // 1. Scan specific country schedules
    for (const country of countries) {
      const list = await fetchJSON(`https://api.tvmaze.com/schedule?country=${country}&date=${dateStr}`);
      if (!Array.isArray(list)) continue;
      for (const ep of list) {
        const show = ep.show || ep._embedded?.show;
        if (show?.id && !isExcluded(show)) activeShowIds.add(show.id);
      }
    }

    // 2. Scan Web schedule
    const webList = await fetchJSON(`https://api.tvmaze.com/schedule/web?date=${dateStr}`);
    if (Array.isArray(webList)) {
      for (const ep of webList) {
        const show = ep.show || ep._embedded?.show;
        if (show?.id && !isExcluded(show)) activeShowIds.add(show.id);
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
