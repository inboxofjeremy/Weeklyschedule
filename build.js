/**
 * build.js — Stremio static catalog (TVMaze full metadata authoritative)
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

const TVMAZE_DELAY_MS = 150;
let lastTvmazeCall = 0;

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

// =======================
// FILTERS (unchanged logic)
// =======================
function isBlocked(show) {
  const lang = (show.language || "").toLowerCase();
  const blockedLangs = ["italian","turkish","indonesian","spanish","thai","arabic","norwegian","german","chinese","korean","french","hindi"];
  return blockedLangs.includes(lang);
}

// =======================
// MAIN
// =======================
async function build() {
  const showIds = new Map();

  // =======================
  // STEP 1: COLLECT SHOW IDS
  // =======================
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);

    const schedule = await fetchJSON(
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`
    );

    if (!Array.isArray(schedule)) continue;

    for (const ep of schedule) {
      const show = ep.show;
      if (!show?.id) continue;

      if (isBlocked(show)) continue;

      showIds.set(show.id, show);
    }
  }

  // =======================
  // STEP 2: FETCH FULL SHOW DATA
  // =======================
  const metas = [];

  for (const [id, basicShow] of showIds.entries()) {
    const full = await fetchJSON(
      `https://api.tvmaze.com/shows/${id}?embed=episodes`
    );

    if (!full?._embedded?.episodes) continue;

    const imdb = full.externals?.imdb || null;
    const stremioId = imdb || `tvmaze:${id}`;

    const videos = full._embedded.episodes
      .filter(e => e.airdate)
      .map(ep => ({
        id: `${stremioId}:${ep.season}:${ep.number}`,
        title: ep.name,
        season: ep.season,
        episode: ep.number,
        released: ep.airdate,
        overview: cleanHTML(ep.summary)
      }))
      .sort((a, b) => new Date(a.released) - new Date(b.released));

    if (!videos.length) continue;

    metas.push({
      id: stremioId,
      type: "series",
      name: full.name,
      description: cleanHTML(full.summary),
      poster: full.image?.original || full.image?.medium || null,
      background: full.image?.original || null,
      videos
    });
  }

  // sort newest first
  metas.sort(
    (a, b) =>
      new Date(b.videos[b.videos.length - 1].released) -
      new Date(a.videos[a.videos.length - 1].released)
  );

  fs.mkdirSync(CATALOG_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_full_metadata.json"),
    JSON.stringify({ metas }, null, 2)
  );

  console.log("Build complete:", metas.length, "shows");
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
