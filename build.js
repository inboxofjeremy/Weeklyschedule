/**
 * build.js — Stremio static catalog
 */

import fs from "fs";
import path from "path";

const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const OUT_DIR = "./";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");
const DAYS_BACK = 9;
const TVMAZE_DELAY_MS = 150;
let lastTvmazeCall = 0;

// Helper to get the most recent valid date string for a show
function getLatestDate(show) {
  const dates = (show.videos || [])
    .map(v => v.released)
    .filter(d => d && typeof d === 'string' && d.includes('-'));
  return dates.length > 0 ? dates.sort().reverse()[0] : "0000-00-00";
}

// ... (fetchJSON, cleanHTML, pacificDateString, isExcluded, findTmdbId remain the same)

async function build() {
  // ... (Discovery Phase remains the same)

  const metas = [];
  // ... (Loop to build metas remains the same)

  // 1. FILTER: Calculate the cutoff date string
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_BACK);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const filteredMetas = metas.filter(show => {
    // A show is kept ONLY if its latest episode is >= cutoff date
    return getLatestDate(show) >= cutoffStr;
  });

  // 2. SORT: Sort by the latest release date (string comparison is safe and consistent)
  filteredMetas.sort((a, b) => {
    return getLatestDate(b).localeCompare(getLatestDate(a));
  });

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"), JSON.stringify({ metas: filteredMetas }, null, 2));
  console.log(`=== BUILD COMPLETE: ${filteredMetas.length} active shows sorted by latest release ===`);
}
