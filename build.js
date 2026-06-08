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
      if (wait) await new Promise(r => setTimeout(r));
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

  return `${parts.find(p => p.type === "year").value}-${
    parts.find(p => p.type === "month").value
  }-${
    parts.find(p => p.type === "day").value
  }`;
}

function normalizeDate(ep) {
  const raw =
    ep?.airstamp ||
    ep?.airdate ||
    ep?.show?.premiered ||
    null;

  return raw ? raw.slice(0, 10) : null;
}

// =======================
// WINDOW CHECK (SHOW LEVEL ONLY)
// =======================

function isInWindow(epDate) {
  if (!epDate) return false;

  const today = new Date();
  today.setHours(0,0,0,0);

  const start = new Date(today);
  start.setDate(start.getDate() - (DAYS_BACK - 1));

  const ep = new Date(epDate);
  ep.setHours(0,0,0,0);

  return ep >= start && ep <= today;
}

// =======================
// FILTERS (UNCHANGED)
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

function isDocumentary(show) {
  return (show.type || "").toLowerCase() === "documentary" ||
    (show.genres || []).some(g => g?.toLowerCase() === "documentary");
}

function isBlockedPlatform(show) {
  return (show?.webChannel?.name || "").toLowerCase() === "tubi";
}

function isLegal(show) {
  return (show.genres || []).some(g => g?.toLowerCase() === "legal");
}

function isBlockedLanguage(show) {
  const blocked = [
    "italian","turkish","indonesian","spanish","thai",
    "arabic","norwegian","german","chinese","korean",
    "french","hindi"
  ];

  return blocked.includes(String(show?.language || "").toLowerCase());
}

// =======================
// TMDB (UNCHANGED)
// =======================

async function findTmdbId(show) {
  let imdb = show?.externals?.imdb;

  if (!imdb) {
    const full = await fetchJSON(`https://api.tvmaze.com/shows/${show.id}`);
    imdb = full?.externals?.imdb;
  }

  if (imdb) {
    const url =
      `https://api.themoviedb.org/3/find/${imdb}` +
      `?api_key=${TMDB_API_KEY}&external_source=imdb_id`;

    const data = await fetchJSON(url);
    const id = data?.tv_results?.[0]?.id;
    if (id) return id;
  }

  const searchUrl =
    `https://api.themoviedb.org/3/search/tv` +
    `?api_key=${TMDB_API_KEY}` +
    `&query=${encodeURIComponent(show.name)}`;

  const search = await fetchJSON(searchUrl);
  return search?.results?.[0]?.id || null;
}

// =======================
// MAIN BUILD
// =======================

async function build() {

  const showMap = new Map();
  const eligibleShows = new Set(); // 🔴 SHOW-LEVEL FILTER

  // STEP 1: detect eligible shows from window
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

        const epDate = normalizeDate(ep);
        if (!epDate) continue;

        if (isInWindow(epDate)) {
          eligibleShows.add(show.id);
        }
      }
    }
  }

  console.log("Eligible shows:", eligibleShows.size);

  // STEP 2: collect ALL episodes for eligible shows
  const episodeSet = new Set();

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

        if (!eligibleShows.has(show.id)) continue;

        const isBlankety = show.name?.toLowerCase().includes("blankety");

        const epDate = normalizeDate(ep);

        if (isBlankety) {
          console.log("\n=== BLANKETY DEBUG ===");
          console.log("EP:", ep.name);
          console.log("DATE:", epDate);
        }

        if (!showMap.has(show.id)) {
          showMap.set(show.id, { show, episodes: [] });
        }

        const key = `${show.id}:${ep.season}:${ep.number}`;

        if (episodeSet.has(key)) {
          if (isBlankety) console.log("DROP DUPLICATE:", key);
          continue;
        }

        episodeSet.add(key);

        showMap.get(show.id).episodes.push({ ...ep, show });

        if (isBlankety) console.log("KEEP");
      }
    }
  }

  // STEP 3: build output
  const metas = [];

  fs.mkdirSync(CATALOG_DIR, { recursive: true });

  for (const entry of showMap.values()) {
    const show = entry.show;
    const episodes = entry.episodes;

    if (show.name?.toLowerCase().includes("blankety")) {
      console.log("\n=== FINAL BLANKETY ===");
      console.log("episodes:", episodes.length);
    }

    if (!episodes.length) continue;

    const tmdbId = await findTmdbId(show);

    const stremioId = tmdbId
      ? `tmdb:${tmdbId}`
      : `tmdb:${900000000 + show.id}`;

    metas.push({
      id: stremioId,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),
      poster: show.image?.original || show.image?.medium || null,
      background: show.image?.original || null,
      videos: episodes.map(ep => ({
        id: `${stremioId}:${ep.season || 0}:${ep.number || 0}`,
        title: ep.name || `Episode ${ep.number || 0}`,
        season: ep.season || 0,
        episode: ep.number || 0,
        released: normalizeDate(ep),
        overview: cleanHTML(ep.summary || "")
      }))
    });
  }

  console.log("Build complete:", metas.length);

  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas }, null, 2)
  );
}

build().catch(console.error);
