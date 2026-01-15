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
const OUT_DIR = ".";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");

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

function daysAgo(dateStr, n, todayStr) {
  const today = new Date(todayStr);
  const start = new Date(todayStr);
  start.setDate(start.getDate() - n);
  const d = new Date(dateStr);
  return d >= start && d <= today;
}

// =======================
// FILTERS (FIXED)
// =======================
function isSports(show) {
  return (show.type || "").toLowerCase() === "sports";
}

function isNews(show) {
  return (show.type || "").toLowerCase() === "news";
}

function isForeign(show) {
  const allowed = ["US", "GB", "CA", "AU", "IE", "NZ"];
  const c =
    show?.network?.country?.code ||
    show?.webChannel?.country?.code ||
    null;

  if (!c) return false; // allow web-only UK shows
  return !allowed.includes(c.toUpperCase());
}

function isBlockedWebChannel(show) {
  return (show?.webChannel?.name || "").toLowerCase() === "iqiyi";
}

function isYouTubeShow(show) {
  return (show?.webChannel?.name || "").toLowerCase().includes("youtube");
}

// =======================
// TMDB FALLBACK
// =======================
async function tmdbFromTvdb(tvdb) {
  if (!tvdb) return null;
  const url = `https://api.themoviedb.org/3/find/${tvdb}?api_key=${TMDB_API_KEY}&external_source=tvdb_id`;
  const data = await fetchJSON(url);
  return data?.tv_results?.[0] || null;
}

// =======================
// MAIN BUILD
// =======================
async function build() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const showMap = new Map();

  // =======================
  // DISCOVER SCHEDULE (10 DAYS)
  // =======================
  for (let i = 0; i < 10; i++) {
    const d = new Date(todayStr);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    const sources = [
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`,
      `https://api.tvmaze.com/schedule/web?date=${dateStr}`,
      `https://api.tvmaze.com/schedule/full?date=${dateStr}`
    ];

    for (const url of sources) {
      const list = await fetchJSON(url);
      if (!Array.isArray(list)) continue;

      for (const ep of list) {
        const show = ep.show || ep._embedded?.show;
        if (!show?.id) continue;

        if (
          isNews(show) ||
          isSports(show) ||
          isForeign(show) ||
          isBlockedWebChannel(show) ||
          isYouTubeShow(show)
        ) continue;

        const key = show.id;

        if (!showMap.has(key)) {
          showMap.set(key, { show, episodes: [] });
        }
        showMap.get(key).episodes.push(ep);
      }
    }
  }

  // =======================
  // BUILD METAS
  // =======================
  const metas = [];

  for (const entry of showMap.values()) {
    // sort episodes newest first
    entry.episodes.sort((a, b) => {
      const da = pickDate(a);
      const db = pickDate(b);
      return da < db ? 1 : -1;
    });

    // keep only last 10 days
    const recent = entry.episodes.filter(ep => {
      const d = pickDate(ep);
      return d && daysAgo(d, 10, todayStr);
    });

    if (!recent.length) continue;

    let id = entry.show.externals?.imdb;

    // TMDB fallback if IMDb missing
    if (!id && entry.show.externals?.thetvdb) {
      const tmdb = await tmdbFromTvdb(entry.show.externals.thetvdb);
      if (tmdb?.id) id = `tmdb:${tmdb.id}`;
    }

    if (!id) continue;

    metas.push({
      id,
      type: "series",
      name: entry.show.name,
      description: cleanHTML(entry.show.summary),
      poster: entry.show.image?.original || entry.show.image?.medium || null,
      background: entry.show.image?.original || null,
      videos: recent.map(ep => ({
        id: `${id}:${ep.season}:${ep.number}`,
        title: ep.name,
        season: ep.season,
        episode: ep.number,
        released: pickDate(ep),
        overview: cleanHTML(ep.summary)
      }))
    });

    console.log("Added:", entry.show.name, id);
  }

  // =======================
  // FINAL SORT (CRITICAL)
  // =======================
  metas.sort((a, b) => {
    const da = a.videos[0]?.released || "0000-00-00";
    const db = b.videos[0]?.released || "0000-00-00";
    return da < db ? 1 : -1;
  });

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
