/**
 * build.js — Stremio static catalog (IMDb + TMDB fallback)
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

function pickDate(ep) {
  return ep?.airdate && ep.airdate !== "0000-00-00"
    ? ep.airdate
    : ep?.airstamp?.slice(0, 10) || null;
}

// --- PACIFIC TIME YYYY-MM-DD ---
function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function filterLastNDays(episodes, n, todayStr) {
  const today = new Date(todayStr);
  const start = new Date(todayStr);
  start.setDate(start.getDate() - (n - 1));

  return episodes.filter(ep => {
    const d = pickDate(ep);
    if (!d || d > todayStr) return false; // hard stop future episodes
    const dt = new Date(d);
    return dt >= start && dt <= today;
  });
}

// =======================
// CONTENT FILTERS
// =======================
function isSports(show) {
  return (show.type || "").toLowerCase() === "sports" ||
    (show.genres || []).some(g => g?.toLowerCase() === "sports");
}

function isNews(show) {
  const t = (show.type || "").toLowerCase();
  const isPanel = (show.genres || []).some(g =>
    ["panel", "quiz", "game show"].includes(g?.toLowerCase())
  );
  if (isPanel) return false;
  return t === "news" || t === "talk show";
}

function isForeign(show) {
  const allowed = ["US", "GB", "CA", "AU", "IE", "NZ"];
  const c =
    show?.network?.country?.code ||
    show?.webChannel?.country?.code ||
    "";
  return c && !allowed.includes(c.toUpperCase());
}

function isBlockedWebChannel(show) {
  return (show?.webChannel?.name || "").toLowerCase() === "iqiyi";
}

function isYouTubeShow(show) {
  return (show?.webChannel?.name || "").toLowerCase().includes("youtube");
}

// =======================
// TMDB ENRICHMENT
// =======================
async function tmdbFindByImdb(imdb) {
  const url = `https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  const data = await fetchJSON(url);
  return data?.tv_results?.[0] || null;
}

async function tmdbFindByName(show) {
  const name = encodeURIComponent(show.name);
  const year = show.premiered?.slice(0, 4) || "";
  const url = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${name}&first_air_date_year=${year}`;
  const data = await fetchJSON(url);
  return data?.results?.[0] || null;
}

// =======================
// MAIN BUILD
// =======================
async function build() {
  const todayStr = pacificDateString(); // ✅ Pacific Time
  const showMap = new Map();

  // --- DISCOVER SCHEDULE (last 10 days, PT-safe)
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);

    for (const url of [
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`,
      `https://api.tvmaze.com/schedule/web?date=${dateStr}`,
      `https://api.tvmaze.com/schedule/full?date=${dateStr}`
    ]) {
      const list = await fetchJSON(url);
      if (!Array.isArray(list)) continue;

      for (const ep of list) {
        const show = ep.show || ep._embedded?.show;
        if (!show?.id) continue;

        if (
          isSports(show) ||
          isForeign(show) ||
          isBlockedWebChannel(show) ||
          isYouTubeShow(show) ||
          isNews(show)
        ) continue;

        if (!showMap.has(show.id)) {
          showMap.set(show.id, { show, episodes: [ep] });
        } else {
          showMap.get(show.id).episodes.push(ep);
        }
      }
    }
  }

  // =======================
  // ENRICH IDs (IMDb → TMDB fallback)
  // =======================
  for (const entry of showMap.values()) {
    let imdb = entry.show.externals?.imdb;
    let tmdbId = null;

    if (imdb) {
      const tmdb = await tmdbFindByImdb(imdb);
      if (tmdb?.id) tmdbId = tmdb.id;
    } else {
      const tmdb = await tmdbFindByName(entry.show);
      if (tmdb?.id) tmdbId = tmdb.id;
    }

    if (imdb) entry.stremioId = imdb;
    else if (tmdbId) entry.stremioId = `tmdb:${tmdbId}`;
  }

  // =======================
  // BUILD STREMIO CATALOG
  // =======================
  const metas = [];

  for (const entry of showMap.values()) {
    if (!entry.stremioId) continue;

    const recent = filterLastNDays(entry.episodes, DAYS_BACK, todayStr);
    if (!recent.length) continue;

    recent.sort((a, b) => new Date(pickDate(a)) - new Date(pickDate(b)));

    metas.push({
      id: entry.stremioId,
      type: "series",
      name: entry.show.name,
      description: cleanHTML(entry.show.summary),
      poster: entry.show.image?.original || entry.show.image?.medium || null,
      background: entry.show.image?.original || null,
      videos: recent.map(ep => ({
        id: `${entry.stremioId}:${ep.season || 0}:${ep.number || ep.id}`,
        title: ep.name,
        season: ep.season || 0,
        episode: ep.number || 0,
        released: pickDate(ep),
        overview: cleanHTML(ep.summary)
      }))
    });
  }

  // ✅ latest episode first, today at top
  metas.sort((a, b) =>
    new Date(b.videos[b.videos.length - 1].released) -
    new Date(a.videos[a.videos.length - 1].released)
  );

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas }, null, 2)
  );

  console.log("Build complete:", metas.length, "shows");
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
