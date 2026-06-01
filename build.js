/**
 * build.js — Final Fixed Version
 */

import fs from "fs";
import path from "path";

const TMDB_API_KEY = process.env.TMDB_API_KEY; 
const OUT_DIR = "./";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");
const META_DIR = path.join(OUT_DIR, "meta", "series");
const DAYS_BACK = 10;

// [fetchJSON, Helpers, Filters, findTmdbId, processEpisodeList remain the same as previously provided]

async function build() {
  const showMap = new Map();
  // ... (Fetch logic remains the same)

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.mkdirSync(META_DIR, { recursive: true });

  for (const entry of showMap.values()) {
    const show = entry.show;
    const stremioId = `tvmaze${show.id}`;
    
    const episodes = entry.episodes;
    if (!episodes.length) continue;

    const videos = episodes.map(ep => ({
      id: `${stremioId}:${ep.season || 0}:${ep.number || 0}`,
      title: ep.name || `Episode ${ep.number || 0}`,
      season: ep.season || 0,
      episode: ep.number || 0,
      released: getStrictEpisodeDate(ep),
      overview: cleanHTML(ep.summary || "")
    }));

    // [FIX]: Added required genres and posterShape fields
    const metaObj = {
      id: stremioId,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),
      poster: show.image?.original || show.image?.medium || null,
      background: show.image?.original || null,
      genres: show.genres || ["TV"], 
      posterShape: "poster",
      videos
    };

    metas.push(metaObj);

    // [FIX]: Stremio requires { "meta": metaObj }
    fs.writeFileSync(
      path.join(META_DIR, `${stremioId}.json`),
      JSON.stringify({ meta: metaObj }, null, 2)
    );
  }

  // ... (Sort and write catalog logic)
}
