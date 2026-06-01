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

  return `${parts.find(p => p.type === "year").value}-${
    parts.find(p => p.type === "month").value
  }-${
    parts.find(p => p.type === "day").value
  }`;
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

  return !(isPanel) && (t === "news" || t === "talk show");
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
// TMDB LOOKUP (UNCHANGED LOGIC)
// =======================
async function findTmdbId(show) {
  const imdb = show?.externals?.imdb;

  if (imdb) {
    const data = await fetchJSON(
      `https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );

    const id = data?.tv_results?.[0]?.id;
    if (id) return id;
  }

  const name = encodeURIComponent(show.name);
  const year = show?.premiered?.slice(0, 4) || "";

  const data = await fetchJSON(
    `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${name}` +
    (year ? `&first_air_date_year=${year}` : "")
  );

  const id = data?.results?.[0]?.id;
  if (!id) return null;

  const verify = await fetchJSON(
    `https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_API_KEY}`
  );

  return verify?.id ? id : null;
}

// =======================
// MAIN BUILD
// =======================
async function build() {
  const showMap = new Map();

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
          isBlockedLanguage(show) ||
          isDocumentary(show) ||
          isBlockedWebChannel(show) ||
          isYouTubeShow(show) ||
          isLegal(show) ||
          isBlockedPlatform(show) ||
          isNews(show)
        ) continue;

        showMap.set(show.id, { show });
      }
    }
  }

  const metas = [];

  for (const { show } of showMap.values()) {
    const tmdbId = await findTmdbId(show);
    if (!tmdbId) continue;

    const stremioId = `tmdb:${tmdbId}`;

    const episodes = await fetchJSON(
      `https://api.tvmaze.com/shows/${show.id}/episodes`
    );

    if (!Array.isArray(episodes)) continue;

    const videos = episodes
      .filter(ep => ep?.season != null && ep?.number != null)
      .map(ep => ({
        // 🔥 OPTION A FIX: break TMDB reconciliation dependency
        id: `${stremioId}-S${ep.season}-E${ep.number}-${ep.id}`,

        title: ep.name || `Episode ${ep.number}`,
        season: ep.season,

        // IMPORTANT: no longer used for grouping logic
        episode: ep.id,

        released: ep.airdate || null,
        overview: cleanHTML(ep.summary || "")
      }))
      .sort((a, b) =>
        new Date(a.released || 0) - new Date(b.released || 0)
      );

    metas.push({
      id: stremioId,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),
      poster: show.image?.original || show.image?.medium || null,
      background: show.image?.original || null,
      videos
    });
  }

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
