/**
 * build.js — Stremio static catalog (TVMaze schedule + TMDB ID merge)
 * FIXED: loop-free + stable episode source
 */

import fs from "fs";
import path from "path";

// =======================
// CONFIG
// =======================
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const OUT_DIR = "./";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");

// keep your intent window but no longer used for filtering schedule
const DAYS_BACK = 10;

// =======================
// TVMAZE RATE LIMIT
// =======================
const TVMAZE_DELAY_MS = 150;
let lastTvmazeCall = 0;

async function fetchJSON(url) {
  try {
    if (url.includes("api.tvmaze.com")) {
      const wait = Math.max(
        0,
        TVMAZE_DELAY_MS - (Date.now() - lastTvmazeCall)
      );

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
const cleanHTML = s => (s ? s.replace(/<[^>]+>/g, "").trim() : "");

function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return `${parts.find(p => p.type === "year").value}-${
    parts.find(p => p.type === "month").value
  }-${parts.find(p => p.type === "day").value}`;
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

function isBlockedWebChannel(show) {
  return (show?.webChannel?.name || "").toLowerCase() === "iqiyi";
}

function isYouTubeShow(show) {
  return (show?.webChannel?.name || "").toLowerCase().includes("youtube");
}

function isDocumentary(show) {
  return (
    (show.type || "").toLowerCase() === "documentary" ||
    (show.genres || []).some(g => g?.toLowerCase() === "documentary")
  );
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
    const full = await fetchJSON(
      `https://api.tvmaze.com/shows/${show.id}`
    );
    imdb = full?.externals?.imdb;
  }

  if (imdb) {
    const url =
      `https://api.themoviedb.org/3/find/${imdb}` +
      `?api_key=${TMDB_API_KEY}&external_source=imdb_id`;

    const data = await fetchJSON(url);
    return data?.tv_results?.[0]?.id || null;
  }

  const searchUrl =
    `https://api.themoviedb.org/3/search/tv` +
    `?api_key=${TMDB_API_KEY}` +
    `&query=${encodeURIComponent(show.name)}`;

  const search = await fetchJSON(searchUrl);

  return search?.results?.[0]?.id || null;
}

// =======================
// CANONICAL EPISODES (NEW SOURCE OF TRUTH)
// =======================
async function fetchAllEpisodes(showId) {
  return await fetchJSON(
    `https://api.tvmaze.com/shows/${showId}/episodes`
  ) || [];
}

// =======================
// MAIN BUILD
// =======================
async function build() {

  console.log("=== BUILD START ===");

  const showMap = new Map();
  const seenShows = new Set();

  // =======================
  // STEP 1: DISCOVER SHOWS VIA SCHEDULE ONLY
  // =======================
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

        if (seenShows.has(show.id)) continue;
        seenShows.add(show.id);

        showMap.set(show.id, {
          show,
          episodes: []
        });
      }
    }
  }

  // =======================
  // STEP 2: CANONICAL EPISODES PER SHOW
  // =======================
  for (const entry of showMap.values()) {

    const show = entry.show;

    const eps = await fetchAllEpisodes(show.id);

    const now = new Date(pacificDateString(new Date()) + "T00:00:00Z");

    const filtered = eps.filter(e => {
      if (!e?.airdate) return false;

      const d = new Date(e.airdate + "T00:00:00Z");

      // keep past + near future window (prevents Blankety Blank loss)
      const futureWindow = new Date(now);
      futureWindow.setDate(now.getDate() + 21);

      const inRange = d >= new Date(now.getTime() - 1000 * 60 * 60 * 24 * DAYS_BACK)
                   && d <= futureWindow;

      if (!inRange) return false;

      // APPLY YOUR ORIGINAL FILTERS
      if (
        isSports(show) ||
        isForeign(show) ||
        isBlockedLanguage(show) ||
        isDocumentary(show) ||
        isBlockedWebChannel(show) ||
        isYouTubeShow(show) ||
        isLegal(show) ||
        isBlockedPlatform(show) ||
        isNews(show)
      ) return false;

      return true;
    });

    entry.episodes = filtered;

    if (show.name?.toLowerCase().includes("blankety")) {
      console.log("\n=== BLANKETY DEBUG ===");
      console.log("episodes:", filtered.length);
    }
  }

  // =======================
  // OUTPUT
  // =======================
  const metas = [];

  fs.mkdirSync(CATALOG_DIR, { recursive: true });

  for (const entry of showMap.values()) {

    if (!entry.episodes.length) continue;

    const show = entry.show;

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
      videos: entry.episodes.map(ep => ({
        id: `${stremioId}:${ep.season || 0}:${ep.number || 0}`,
        title: ep.name || `Episode ${ep.number || 0}`,
        season: ep.season || 0,
        episode: ep.number || 0,
        released: ep.airdate || ep.airstamp?.slice(0, 10) || null,
        overview: cleanHTML(ep.summary || "")
      }))
    });
  }

  console.log("\nBuild complete:", metas.length);

  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas }, null, 2)
  );
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
