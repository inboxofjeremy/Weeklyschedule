/**
 * build.js — Stremio static catalog (TVMaze schedule + TMDB ID merge)
 */

import fs from "fs";
import path from "path";

const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const CATALOG_DIR = path.join("./", "catalog", "series");
const DAYS_BACK = 10;

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const cleanHTML = s => (s ? s.replace(/<[^>]+>/g, "").trim() : "");

// =======================
// TMDB LOOKUP
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
// MAIN
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
    if (!tmdbId) continue;

    // =========================
    // IMPORTANT: KEEP TMDB FOR STREMIO COMPATIBILITY
    // =========================
    const stremioId = `tmdb:${tmdbId}`;

    // =========================
    // ALWAYS SOURCE EPISODES FROM TVMAZE (AUTHORITATIVE)
    // =========================
    const episodes = await fetchJSON(
      `https://api.tvmaze.com/shows/${show.id}/episodes`
    );

    if (!Array.isArray(episodes)) continue;

    // 🔥 CRITICAL FIX: prevent ANY implicit truncation or grouping issues
    const videos = episodes.map(ep => ({
      id: `${stremioId}:${ep.season}:${ep.number}:${show.id}`,

      title: ep.name || `Episode ${ep.number}`,
      season: Number(ep.season),
      episode: Number(ep.number),

      released: ep.airdate || "",

      overview: cleanHTML(ep.summary || ""),

      // 🔥 KEY FIX: explicit external source binding
      externalIds: {
        tvmaze: show.id
      }
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

build().catch(console.error);
