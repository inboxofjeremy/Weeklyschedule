/**
 * build.js — Stremio static catalog (TVMaze schedule + TMDB metadata fallback)
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
// RATE LIMIT
// =======================
const TVMAZE_DELAY_MS = 150;
let lastTvmazeCall = 0;

// =======================
// CACHE
// =======================
const tmdbCache = new Map();

// =======================
// FETCH
// =======================
async function fetchJSON(url) {
  try {
    if (url.includes("api.tvmaze.com")) {
      const wait = Math.max(
        0,
        TVMAZE_DELAY_MS - (Date.now() - lastTvmazeCall)
      );

      if (wait) {
        await new Promise(r => setTimeout(r, wait));
      }

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
const cleanHTML = s =>
  s ? s.replace(/<[^>]+>/g, "").trim() : "";

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

// =======================
// FILTERS (UNCHANGED)
// =======================
function isSports(show) {
  return (
    (show.type || "").toLowerCase() === "sports" ||
    (show.genres || []).some(g => g?.toLowerCase() === "sports")
  );
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

function isBlockedLanguage(show) {
  const blocked = [
    "italian","turkish","indonesian","spanish","thai",
    "arabic","norwegian","german","chinese","korean","french","hindi"
  ];

  const lang = String(show?.language || "").trim().toLowerCase();
  return blocked.includes(lang);
}

// =======================
// TMDB (unchanged)
// =======================
async function getTmdbIdForShow(show) {
  if (tmdbCache.has(show.id)) {
    return tmdbCache.get(show.id);
  }

  const name = encodeURIComponent(show.name);
  const year = show.premiered?.slice(0, 4) || "";

  const url =
    `https://api.themoviedb.org/3/search/tv` +
    `?api_key=${TMDB_API_KEY}` +
    `&query=${name}` +
    `&first_air_date_year=${year}`;

  const data = await fetchJSON(url);

  const id = data?.results?.[0]?.id || null;
  tmdbCache.set(show.id, id);

  return id;
}

// =======================
// FULL EPISODES (FIX)
// =======================
async function getFullEpisodes(showId) {
  return await fetchJSON(
    `https://api.tvmaze.com/shows/${showId}/episodes`
  );
}

// =======================
// MAIN BUILD
// =======================
async function build() {
  const showMap = new Map();

  // =======================
  // STEP 1: FIND RELEVANT SHOWS (schedule only used for discovery)
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
      if (!show?.id) continue;

      if (
        isSports(show) ||
        isForeign(show) ||
        isBlockedLanguage(show) ||
        isNews(show)
      ) continue;

      if (!showMap.has(show.id)) {
        showMap.set(show.id, {
          show,
          lastAirDate: dateStr,
          episodes: []
        });
      }
    }
  }

  // =======================
  // STEP 2: GET FULL EPISODES (FIX CORE ISSUE)
  // =======================
  for (const entry of showMap.values()) {
    const full = await getFullEpisodes(entry.show.id);

    if (Array.isArray(full)) {
      entry.episodes = full;
    }
  }

  // =======================
  // STEP 3: ENRICH TMDB ID ONLY
  // =======================
  for (const entry of showMap.values()) {
    const tmdbId = await getTmdbIdForShow(entry.show);

    entry.stremioId =
      tmdbId ? `tmdb:${tmdbId}` : `tvmaze:${entry.show.id}`;
  }

  // =======================
  // STEP 4: BUILD OUTPUT
  // =======================
  const metas = [];

  for (const entry of showMap.values()) {
    const videos = entry.episodes
      .filter(ep => ep?.name)
      .map(ep => ({
        id: `${entry.stremioId}:${ep.season}:${ep.number}`,
        title: ep.name,
        season: ep.season,
        episode: ep.number,
        released: ep.airdate,
        overview: cleanHTML(ep.summary)
      }))
      .sort((a, b) => new Date(a.released) - new Date(b.released));

    metas.push({
      id: entry.stremioId,
      type: "series",
      name: entry.show.name,
      description: cleanHTML(entry.show.summary),
      poster: entry.show.image?.original || entry.show.image?.medium || null,
      background: entry.show.image?.original || null,
      videos
    });
  }

  // =======================
  // SORT SHOWS BY LAST AIR DATE
  // =======================
  metas.sort((a, b) =>
    new Date(b.videos.at(-1)?.released || 0) -
    new Date(a.videos.at(-1)?.released || 0)
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
