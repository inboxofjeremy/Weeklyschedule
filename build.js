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
        await new Promise(r => setTimeout(r));
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

function getStrictEpisodeDate(ep) {
  return ep?.airdate && ep.airdate !== "0000-00-00"
    ? ep.airdate
    : ep?.airstamp?.slice(0, 10) || null;
}

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
// WINDOW FIX (ONLY REAL CHANGE)
// =======================
function isInWindow(epDate) {
  if (!epDate) return false;

  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - (DAYS_BACK - 1));

  const d = new Date(epDate + "T00:00:00Z");

  return d >= start && d <= today;
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
// TMDB LOOKUP (UNCHANGED)
// =======================
async function findTmdbId(show) {
  const imdb = show?.externals?.imdb || null;
  if (!imdb) return null;

  const url =
    `https://api.themoviedb.org/3/find/${imdb}` +
    `?api_key=${TMDB_API_KEY}&external_source=imdb_id`;

  const data = await fetchJSON(url);

  return data?.tv_results?.[0]?.id || null;
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

        const epDate = getStrictEpisodeDate(ep);
        if (!epDate) continue;

        // 🔥 FINAL FIX: correct window enforcement
        if (!isInWindow(epDate)) continue;

        if (!showMap.has(show.id)) {
          showMap.set(show.id, {
            show,
            episodes: []
          });
        }

        showMap.get(show.id).episodes.push(ep);
      }
    }
  }

  const metas = [];

  for (const entry of showMap.values()) {
    const show = entry.show;

    const tmdbId = await findTmdbId(show);

    const stremioId = tmdbId
      ? `tmdb:${tmdbId}`
      : `tmdb:${900000000 + show.id}`;

    const episodes = entry.episodes;
    if (!episodes.length) continue;

    episodes.sort((a, b) => {
      const at = new Date(getStrictEpisodeDate(a) || 0).getTime();
      const bt = new Date(getStrictEpisodeDate(b) || 0).getTime();
      return at - bt;
    });

    const videos = episodes.map(ep => ({
      id: `${stremioId}:${ep.season || 0}:${ep.number || 0}`,
      title: ep.name || `Episode ${ep.number || 0}`,
      season: ep.season || 0,
      episode: ep.number || 0,
      released: getStrictEpisodeDate(ep),
      overview: cleanHTML(ep.summary || "")
    }));

    metas.push({
      id: stremioId,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),

      poster:
        show.image?.original ||
        show.image?.medium ||
        null,

      background: show.image?.original || null,
      videos
    });
  }

  metas.sort(
    (a, b) =>
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
