/**
 * build.js — Final production-ready build script
 * Writes to root, includes Stremio-required metadata fields.
 */

import fs from "fs";
import path from "path";

// CONFIG
const TMDB_API_KEY = process.env.TMDB_API_KEY; 
const CATALOG_FILE = "tvmaze_weekly_schedule.json";
const META_DIR = "meta/series";
const DAYS_BACK = 10;

// HELPERS
const cleanHTML = s => (s ? s.replace(/<[^>]+>/g, "").trim() : "");
const getStrictEpisodeDate = ep => ep?.airdate && ep.airdate !== "0000-00-00" ? ep.airdate : ep?.airstamp?.slice(0, 10) || null;

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function findTmdbId(show) {
  const imdb = show?.externals?.imdb;
  if (imdb) {
    const data = await fetchJSON(`https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
    if (data?.tv_results?.[0]?.id) return data.tv_results[0].id;
  }
  const search = await fetchJSON(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(show.name)}`);
  return search?.results?.[0]?.id || null;
}

// MAIN BUILD
async function build() {
  const showMap = new Map();

  // Fetch Schedule
  console.log("Fetching schedules...");
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const list = await fetchJSON(`https://api.tvmaze.com/schedule?country=US&date=${dateStr}`);
    if (Array.isArray(list)) {
      for (const ep of list) {
        const show = ep.show;
        if (!showMap.has(show.id)) showMap.set(show.id, { show, episodes: [] });
        showMap.get(show.id).episodes.push(ep);
      }
    }
  }

  // Ensure directory exists
  if (!fs.existsSync(META_DIR)) fs.mkdirSync(META_DIR, { recursive: true });

  const metas = [];

  for (const entry of showMap.values()) {
    const show = entry.show;
    const stremioId = `tvmaze${show.id}`;
    
    const episodes = entry.episodes.sort((a, b) => new Date(getStrictEpisodeDate(a)) - new Date(getStrictEpisodeDate(b)));

    const videos = episodes.map(ep => ({
      id: `${stremioId}:${ep.season || 0}:${ep.number || 0}`,
      title: ep.name || `Episode ${ep.number || 0}`,
      season: ep.season || 0,
      episode: ep.number || 0,
      released: getStrictEpisodeDate(ep),
      overview: cleanHTML(ep.summary || "")
    }));

    const metaObj = {
      id: stremioId,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),
      poster: show.image?.original || show.image?.medium || null,
      background: show.image?.original || null,
      genres: show.genres?.length ? show.genres : ["TV"],
      posterShape: "poster",
      videos
    };

    metas.push(metaObj);

    // Save Meta File
    fs.writeFileSync(
      path.join(META_DIR, `${stremioId}.json`),
      JSON.stringify({ meta: metaObj }, null, 2)
    );
  }

  // Save Catalog File
  fs.writeFileSync(
    CATALOG_FILE,
    JSON.stringify({ metas }, null, 2)
  );

  console.log(`Build complete: ${metas.length} shows generated.`);
}

build().catch(err => { console.error(err); process.exit(1); });
