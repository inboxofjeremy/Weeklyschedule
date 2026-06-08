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
  }-${parts.find(p => p.type === "day").value}`;
}

function getStrictEpisodeDate(ep) {
  const raw =
    ep?.airdate ||
    (ep?.airstamp ? ep.airstamp.slice(0, 10) : null);

  if (!raw || raw === "0000-00-00") return null;
  return raw;
}

// =======================
// WINDOW FILTER (UNCHANGED)
// =======================

function isInWindow(epDate) {
  if (!epDate) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = new Date(today);
  start.setDate(start.getDate() - (DAYS_BACK - 1));

  const ep = new Date(epDate);
  ep.setHours(0, 0, 0, 0);

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

  // =========================
  // SCHEDULE SEED
  // =========================

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

        // DEBUG: blankety detection
        if (show.name?.toLowerCase().includes("blankety")) {
          console.log("[SCHEDULE HIT]", {
            id: show.id,
            name: show.name,
            type: show.type,
            genres: show.genres,
            network: show.network?.name,
            webChannel: show.webChannel?.name
          });
        }

        if (!showMap.has(show.id)) {
          showMap.set(show.id, { show, episodes: [] });
        }

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

        if (show.name?.toLowerCase().includes("blankety")) {
          console.log("[SCHEDULE EP]", epDate, ep);
        }

        if (!epDate) continue;
        if (!isInWindow(epDate)) continue;

        showMap.get(show.id).episodes.push({ ...ep, show });
      }
    }
  }

  // =========================
  // DISCOVERY PHASE
  // =========================

  const existingIds = new Set(showMap.keys());

  for (let page = 0; page <= 2; page++) {
    const shows = await fetchJSON(`https://api.tvmaze.com/shows?page=${page}`);
    if (!Array.isArray(shows)) continue;

    for (const show of shows) {
      if (!show?.id || existingIds.has(show.id)) continue;

      if (show.name?.toLowerCase().includes("blankety")) {
        console.log("[DISCOVERY HIT]", show);
      }

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

      const episodes = await fetchJSON(
        `https://api.tvmaze.com/shows/${show.id}/episodes`
      );

      if (show.name?.toLowerCase().includes("blankety")) {
        console.log("[DISCOVERY EPISODES RAW]", episodes?.length);
      }

      if (!Array.isArray(episodes)) continue;

      const filtered = episodes.filter(ep => {
        const epDate = getStrictEpisodeDate(ep);

        if (show.name?.toLowerCase().includes("blankety")) {
          console.log("[DISCOVERY EP]", epDate);
        }

        return epDate && isInWindow(epDate);
      });

      if (show.name?.toLowerCase().includes("blankety")) {
        console.log("[DISCOVERY FILTERED COUNT]", filtered.length);
      }

      if (!filtered.length) continue;

      showMap.set(show.id, {
        show,
        episodes: filtered.map(ep => ({ ...ep, show }))
      });
    }
  }

  // =========================
  // FINAL BUILD
  // =========================

  const metas = [];

  fs.mkdirSync(CATALOG_DIR, { recursive: true });

  for (const entry of showMap.values()) {
    const show = entry.show;
    const episodes = entry.episodes;

    if (show.name?.toLowerCase().includes("blankety")) {
      console.log("[FINAL ENTRY]", episodes.length);
    }

    if (!episodes.length) continue;

    const tmdbId = await findTmdbId(show);

    const stremioId = tmdbId
      ? `tmdb:${tmdbId}`
      : `tmdb:${900000000 + show.id}`;

    episodes.sort((a, b) =>
      new Date(getStrictEpisodeDate(a)).getTime() -
      new Date(getStrictEpisodeDate(b)).getTime()
    );

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
        released: getStrictEpisodeDate(ep),
        overview: cleanHTML(ep.summary || "")
      }))
    });
  }

  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas }, null, 2)
  );

  console.log("Build complete:", metas.length);
}

build().catch(console.error);
