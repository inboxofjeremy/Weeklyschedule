/**
 * build.js — SAFE FIX VERSION (NO BREAK CHANGES)
 * Fix: 1-day TVMaze drift only
 */

import fs from "fs";
import path from "path";

const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const DAYS_BACK = 10;

const CATALOG_DIR = path.join("./", "catalog", "series");

// =======================
// FETCH
// =======================
async function fetchJSON(url) {
  try {
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
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function pickDate(ep) {
  return ep?.airdate || ep?.airstamp?.slice(0, 10) || null;
}

// =======================
// 🔥 ONLY FIX: 1-DAY DRIFT CORRECTION
// =======================
function fixOffByOne(dateStr, targetStr) {
  if (!dateStr || !targetStr) return dateStr;

  const d = new Date(dateStr + "T00:00:00Z");
  const t = new Date(targetStr + "T00:00:00Z");

  const diff = Math.round((d - t) / (1000 * 60 * 60 * 24));

  // snap only ±1 day
  if (diff === 1 || diff === -1) {
    return targetStr;
  }

  return dateStr;
}

// =======================
// MAIN
// =======================
async function build() {
  const todayStr = pacificDateString();
  const showMap = new Map();

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

      let epDate = pickDate(ep);
      if (!epDate) continue;

      // 🔥 SAFE FIX APPLIED ONLY HERE
      epDate = fixOffByOne(epDate, dateStr);

      if (!showMap.has(show.id)) {
        showMap.set(show.id, {
          show,
          episodes: []
        });
      }

      showMap.get(show.id).episodes.push({
        ...ep,
        airdate: epDate
      });
    }
  }

  const metas = [];

  for (const entry of showMap.values()) {
    const episodes = entry.episodes;

    if (!episodes.length) continue;

    metas.push({
      id: entry.show.externals?.imdb || `tvmaze:${entry.show.id}`,
      type: "series",
      name: entry.show.name,
      description: entry.show.summary?.replace(/<[^>]+>/g, "") || "",
      poster: entry.show.image?.medium || null,
      background: entry.show.image?.original || null,

      videos: episodes.map(ep => ({
        id: `${entry.show.id}:${ep.id}`,
        title: ep.name,
        season: ep.season || 0,
        episode: ep.number || 0,
        released: ep.airdate,
        overview: ep.summary?.replace(/<[^>]+>/g, "") || ""
      }))
    });
  }

  fs.mkdirSync(CATALOG_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas }, null, 2)
  );

  console.log("Build complete:", metas.length);
}

build().catch(console.error);
