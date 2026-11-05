/**
 * build.js — Stremio & Wako compatible static adult catalog
 * TMDB Daily Discover (9-Day Window, Dynamic Pagination)
 * Strictly preserves all original rules + blocks short vertical dramas & wrestling content.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = process.env.TMDB_API_KEY;

if (!TMDB_API_KEY || TMDB_API_KEY.trim() === "") {
  console.error("\n❌ ERROR: TMDB_API_KEY environment variable is not defined or is empty!\n");
  process.exit(1);
}

const CATALOG_DIR = path.join(__dirname, "catalog", "series");
const RETENTION_DAYS_BACK = 9; // 9-day rolling window
const MAX_PAGES_CAP = 10; // Dynamic cap (up to 200 shows max per day)

const auditLogs = [];

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

async function getTmdbMetadata(tmdbId, country = "US") {
  if (!tmdbId) return null;
  
  const [details, ratingsData, externalIds, keywordsData] = await Promise.all([
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`),
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/content_ratings?api_key=${TMDB_API_KEY}`),
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`),
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/keywords?api_key=${TMDB_API_KEY}`)
  ]);

  if (!details) return null;

  const ratingObj = ratingsData?.results?.find(r => r.iso_3166_1 === country) || ratingsData?.results?.[0];
  const kwList = keywordsData?.results || keywordsData?.keywords || [];
  
  return {
    details,
    certification: ratingObj ? ratingObj.rating : null,
    imdbId: externalIds?.imdb_id || null,
    genres: details.genres ? details.genres.map(g => g.name) : [],
    keywords: kwList.map(k => k.name),
    originalLanguage: details.original_language,
    networks: (details.networks || []).map(n => n.name)
  };
}

// ---------------------------------------------------------------------------------
// EXCLUSION & FILTER LOGIC
// ---------------------------------------------------------------------------------
function evaluateExclusion(showName, tmdbMeta) {
  const name = (showName || "").toLowerCase();
  const genres = (tmdbMeta.genres || []).map(g => g.toLowerCase());
  const lang = (tmdbMeta.originalLanguage || "").toLowerCase();
  const networks = (tmdbMeta.networks || []).map(n => n.toLowerCase());
  const keywords = (tmdbMeta.keywords || []).map(k => k.toLowerCase());
  const lowerOverview = (tmdbMeta.details.overview || "").toLowerCase();

  // 1. Language & Foreign Script Checks
  if (lang !== "en") {
    return { exclude: true, reason: `Excluded: Non-English language ('${lang}')` };
  }

  const nonEnglishCharRegex = /[\u4e00-\u9fa5\u3040-\u30ff\u3130-\u318f\u0400-\u04ff]/;
  if (nonEnglishCharRegex.test(showName)) {
    return { exclude: true, reason: `Excluded: Contains foreign script (${showName})` };
  }

  // 2. Whitelist Overrides
  if (name.includes("blankety blank")) {
    return { exclude: false, reason: "Whitelisted" };
  }

  // 3. Blocked Networks
  const blockedNetworks = [
    "iqiyi", "bilibili", "wavve", "youku", "tencent qq", "vivaone", 
    "premier", "смотрим", "кион", "geo entertainment", "tokyo mx"
  ];
  if (networks.some(net => blockedNetworks.some(b => net.includes(b)))) {
    return { exclude: true, reason: `Excluded: Blocked Network (${networks.join(', ')})` };
  }

  // 4. Professional Wrestling Exclusion
  const wrestlingTerms = [
    "wwe", "aew", "njpw", "impact wrestling", "ring of honor", "smackdown", 
    "wrestlemania", "royal rumble", "professional wrestling", "pro wrestling"
  ];
  if (
    wrestlingTerms.some(term => name.includes(term)) ||
    keywords.some(k => k.includes("wrestling")) ||
    (lowerOverview.includes("wrestling") && (lowerOverview.includes("ring") || lowerOverview.includes("championship")))
  ) {
    return { exclude: true, reason: `Excluded: Professional Wrestling (${showName})` };
  }

  // 5. Exclude Vertical Short Dramas / Micro-Series patterns
  if (
    name.includes("san pito pato") ||
    name.includes("dragon baby") ||
    lowerOverview.includes("vertical drama") ||
    lowerOverview.includes("short drama")
  ) {
    return { exclude: true, reason: `Excluded: Vertical short-drama / micro-series pattern` };
  }

  // 6. Allowed Reality / Renovation / Game Shows
  const allowedGenres = ["panel", "quiz", "game show", "game-show", "reality", "home improvement", "renovation"];
  if (
    genres.some(g => allowedGenres.some(a => g.includes(a))) || 
    name.includes("zombie") || 
    name.includes("beach")
  ) {
    return { exclude: false, reason: "Allowed Reality/Renovation Content" };
  }

  // 7. Excluded Categories (Sports, News, Talk, Pure Documentary)
  if (genres.some(g => g.includes("sports"))) {
    return { exclude: true, reason: "Excluded: Sports" };
  }
  if (genres.some(g => g.includes("news") || g.includes("talk"))) {
    return { exclude: true, reason: "Excluded: News/Talk" };
  }
  if (genres.some(g => g === "documentary")) {
    return { exclude: true, reason: "Excluded: Pure Documentary" };
  }

  return { exclude: false, reason: "Passed general rules" };
}

async function build() {
  const discoveredShows = new Map(); // tmdbId -> latestAirDate

  console.log(`Discovering English adult shows from TMDB across the past ${RETENTION_DAYS_BACK} days (Dynamic Pagination up to ${MAX_PAGES_CAP} pages per day)...`);

  // Dynamic discovery loop
  for (let i = 0; i < RETENTION_DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);

    let page = 1;
    let totalPages = 1;

    do {
      const discoverUrl = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&air_date.gte=${dateStr}&air_date.lte=${dateStr}&with_original_language=en&sort_by=popularity.desc&page=${page}`;
      const data = await fetchJSON(discoverUrl);

      if (data?.results) {
        // Read actual total pages available for this specific date
        totalPages = Math.min(data.total_pages || 1, MAX_PAGES_CAP);

        for (const show of data.results) {
          if (!discoveredShows.has(show.id)) {
            discoveredShows.set(show.id, dateStr);
          }
        }
      }
      page++;
    } while (page <= totalPages);
  }

  console.log(`Discovered ${discoveredShows.size} unique candidate shows. Evaluating metadata...`);

  const metas = [];
  for (const [tmdbId, latestAirDate] of discoveredShows.entries()) {
    const tmdbMeta = await getTmdbMetadata(tmdbId);
    if (!tmdbMeta) continue;

    const showName = tmdbMeta.details.name;
    const audit = evaluateExclusion(showName, tmdbMeta);
    
    if (audit.exclude) {
      auditLogs.push({ name: showName, status: "DROPPED BY FILTER", detail: audit.reason });
      continue;
    }
    
    const imdbId = tmdbMeta.imdbId || null;
    const stremioId = `tmdb:${tmdbId}`;
    const tmdbDetails = tmdbMeta.details;

    metas.push({
      id: stremioId,
      imdb_id: imdbId || undefined,
      tmdb_id: tmdbId,
      type: "series",
      name: showName,
      genres: tmdbMeta.genres,
      year: tmdbDetails.first_air_date ? tmdbDetails.first_air_date.split("-")[0] : undefined,
      description: tmdbDetails.overview || "",
      poster: tmdbDetails.poster_path ? `https://image.tmdb.org/t/p/original${tmdbDetails.poster_path}` : null,
      background: tmdbDetails.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdbDetails.backdrop_path}` : null,
      latestAirDate: latestAirDate
    });

    auditLogs.push({ name: showName, status: "KEPT", detail: `Latest airdate: ${latestAirDate}` });
  }

  // Sort by most recent air date
  metas.sort((a, b) => b.latestAirDate.localeCompare(a.latestAirDate));
  metas.forEach(show => { delete show.latestAirDate; });

  if (!fs.existsSync(CATALOG_DIR)) fs.mkdirSync(CATALOG_DIR, { recursive: true });
  const filePath = path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json");
  fs.writeFileSync(filePath, JSON.stringify({ metas }, null, 2));

  console.log("\n=================================================================================");
  console.log("            TMDB DAILY ADULT DISCOVERY REPORT SUMMARY                            ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
  console.log(`Successfully generated ${metas.length} adult shows in the catalog.`);
}

build().catch(err => { console.error(err); process.exit(1); });
