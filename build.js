/**
 * build.js — Stremio static catalog (TVMaze authority version)
 * Option B: TVMaze ID routing + TMDB enrichment only
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
// HELPERS
// =======================
const cleanHTML = s =>
  s ? s.replace(/<[^>]+>/g, "").trim() : "";

// =======================
// TMDB LOOKUP (metadata only)
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

  const data = await fetchJSON(
    `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${name}`
  );

  return data?.results?.[0]?.id || null;
}

// =======================
// MAIN BUILD
// =======================
async function build() {
  const showMap = new Map();

  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);

    const dateStr = d.toISOString().slice(0, 10);

    const list = await fetchJSON(
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`
    );

    if (!Array.isArray(list)) continue;

    for (const ep of list) {
      const show = ep.show;
      if (!show?.id) continue;

      showMap.set(show.id, { show });
    }
  }

  const metas = [];

  for (const { show } of showMap.values()) {
    const tmdbId = await findTmdbId(show);

    // =====================================================
    // IMPORTANT: TVMAZE IS THE ONLY ID USED BY STREMIO
    // =====================================================
    const stremioId = `tvmaze:${show.id}`;

    const episodes = await fetchJSON(
      `https://api.tvmaze.com/shows/${show.id}/episodes`
    );

    if (!Array.isArray(episodes)) continue;

    const videos = episodes.map(ep => ({
      id: `${stremioId}:${ep.season}:${ep.number}`,

      title: ep.name || `Episode ${ep.number}`,
      season: ep.season,
      episode: ep.number,

      released: ep.airdate || null,
      overview: cleanHTML(ep.summary || ""),

      // optional enrichment only (ignored by Stremio logic)
      tmdbId
    }));

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
