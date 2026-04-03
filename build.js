/**
 * build.js — Stremio static catalog (stable schedule fix)
 * Fix: TVMaze 1-day drift correction
 */

import fs from "fs";
import path from "path";

// =======================
// CONFIG
// =======================
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const DAYS_BACK = 10;

const CATALOG_DIR = path.join("./", "catalog", "series");

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
// DATE HELPERS
// =======================
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

function pickDate(ep) {
  return ep?.airdate && ep.airdate !== "0000-00-00"
    ? ep.airdate
    : ep?.airstamp?.slice(0, 10) || null;
}

// =======================
// 🔥 SMART DATE NORMALIZER (CORE FIX)
// =======================
function normalizeEpisodeDate(rawDate, targetDate) {
  if (!rawDate || !targetDate) return rawDate;

  const raw = new Date(rawDate + "T00:00:00Z");
  const target = new Date(targetDate + "T00:00:00Z");

  const diff = Math.round((raw - target) / (1000 * 60 * 60 * 24));

  // If TVMaze is off by ±1 day → snap to correct day
  if (diff === 1 || diff === -1) {
    return targetDate;
  }

  // otherwise keep original
  return rawDate;
}

// =======================
// FILTER HELPERS
// =======================
const cleanHTML = s => s ? s.replace(/<[^>]+>/g, "").trim() : "";

function isBlocked(show) {
  return (
    (show.type || "").toLowerCase() === "sports" ||
    (show.type || "").toLowerCase() === "news" ||
    (show?.webChannel?.name || "").toLowerCase() === "iqiyi" ||
    (show?.webChannel?.name || "").toLowerCase().includes("youtube")
  );
}

// =======================
// TMDB (ENRICH ONLY)
// =======================
async function tmdbFindByImdb(imdb) {
  const url = `https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  const data = await fetchJSON(url);
  return data?.tv_results?.[0] || null;
}

// =======================
// MAIN
// =======================
async function build() {
  const todayStr = pacificDateString();
  const showMap = new Map();

  // =======================
  // COLLECT SCHEDULE
  // =======================
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);

    const list = await fetchJSON(
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`
    );

    if (!Array.isArray(list)) continue;

    for (const ep of list) {
      const show = ep.show;
      if (!show?.id || isBlocked(show)) continue;

      let epDate = pickDate(ep);
      if (!epDate) continue;

      // 🔥 FIX: normalize 1-day drift
      epDate = normalizeEpisodeDate(epDate, dateStr);

      if (!showMap.has(show.id)) {
        showMap.set(show.id, {
          show,
          episodes: []
        });
      }

      showMap.get(show.id).episodes.push({
        ...ep,
        fixedDate: epDate
      });
    }
  }

  // =======================
  // ENRICH IDS
  // =======================
  for (const entry of showMap.values()) {
    let imdb = entry.show.externals?.imdb;
    let tmdbId = null;

    if (imdb) {
      const tmdb = await tmdbFindByImdb(imdb);
      if (tmdb?.id) tmdbId = tmdb.id;
    }

    entry.stremioId = imdb || (tmdbId ? `tmdb:${tmdbId}` : null);
  }

  // =======================
  // BUILD OUTPUT
  // =======================
  const metas = [];

  for (const entry of showMap.values()) {
    if (!entry.stremioId) continue;

    const episodes = entry.episodes
      .filter(ep => {
        const d = new Date(ep.fixedDate + "T00:00:00Z");
        const today = new Date(todayStr + "T00:00:00Z");

        const diff = (today - d) / (1000 * 60 * 60 * 24);

        return diff >= 0 && diff <= DAYS_BACK;
      })
      .sort((a, b) =>
        new Date(b.fixedDate) - new Date(a.fixedDate)
      );

    if (!episodes.length) continue;

    metas.push({
      id: entry.stremioId,
      type: "series",
      name: entry.show.name,
      description: cleanHTML(entry.show.summary),
      poster: entry.show.image?.medium || null,
      background: entry.show.image?.original || null,

      videos: episodes.map(ep => ({
        id: `${entry.stremioId}:${ep.season}:${ep.number}`,
        title: ep.name,
        season: ep.season,
        episode: ep.number,
        released: ep.fixedDate,
        overview: cleanHTML(ep.summary)
      }))
    });
  }

  // =======================
  // WRITE FILE
  // =======================
  fs.mkdirSync(CATALOG_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas }, null, 2)
  );

  console.log("Build complete:", metas.length, "shows");
}

build().catch(console.error);
