/**
 * build.js — Stremio & Wako compatible static adult catalog
 * TMDB Daily Discover (3-Day Lookahead + 9-Day Rolling Window) + Live Stream Addon Verification
 * Unverified future dates without streams are demoted behind today and confirmed drops.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = process.env.TMDB_API_KEY;
// Base URL of your Stremio stream addon WITHOUT trailing slash or /manifest.json
// Example: https://aiostreams.example.com/your-config-id
const STREAM_ADDON_URL = (process.env.STREAM_ADDON_URL || "")
  .replace(/\/manifest\.json\/?$/, "")
  .replace(/\/$/, "");

if (!TMDB_API_KEY || TMDB_API_KEY.trim() === "") {
  console.error("\n❌ ERROR: TMDB_API_KEY environment variable is not defined or is empty!\n");
  process.exit(1);
}

const CATALOG_DIR = path.join(__dirname, "catalog", "series");
const LOOKAHEAD_DAYS = 3; // Catch streaming episodes dropping up to 3 days before TMDB's official date
const RETENTION_DAYS_BACK = 9; // 9-day rolling window

const auditLogs = [];

async function fetchJSON(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, concurrency, workerFn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await workerFn(items[current], current);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(runners);
  return results;
}

function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * Checks the configured Stremio stream addon to see if an upcoming episode
 * has already dropped and is playable right now.
 */
async function hasLiveStreams(imdbId, season, episode) {
  if (!STREAM_ADDON_URL || !imdbId || season == null || episode == null) return false;

  const streamUrl = `${STREAM_ADDON_URL}/stream/series/${imdbId}:${season}:${episode}.json`;
  const data = await fetchJSON(streamUrl, 2500);

  if (!data || !Array.isArray(data.streams) || data.streams.length === 0) {
    return false;
  }

  // Filter out info/error cards that don't have a playable url, infoHash, or externalUrl
  const playableStreams = data.streams.filter(s =>
    (s.url || s.infoHash || s.externalUrl) &&
    !/no streams|not found|error|rate limit/i.test(`${s.name || ""} ${s.title || ""}`)
  );

  return playableStreams.length > 0;
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
    networks: (details.networks || []).map(n => n.name),
    voteAverage: details.vote_average ?? null,
    voteCount: details.vote_count ?? 0
  };
}

// ---------------------------------------------------------------------------------
// EXCLUSION & FILTER LOGIC
// ---------------------------------------------------------------------------------
function evaluateExclusion(tmdbId, showName, tmdbMeta) {
  const name = (showName || "").toLowerCase();

  // 1. Hardcoded Whitelist Overrides (IDs and Titles)
  const whitelistedIds = [1554, 312415]; // QI, QI XL
  const whitelistedTitles = [
    "qi",
    "qi xl",
    "blankety blank",
    "house shock",
    "home town takeover canada",
    "saturday night live",
    "the adam ray show",
    "awkwafina: the unlikely cook"
  ];

  if (
    whitelistedIds.includes(Number(tmdbId)) ||
    whitelistedTitles.some(title => name === title || name.includes(title))
  ) {
    return { exclude: false, reason: "Whitelisted Override" };
  }

  // 2. User Rating Check: Exclude unrated (0 votes) or ratings below 5%
  if (tmdbMeta.voteCount === 0 || (tmdbMeta.voteAverage !== null && tmdbMeta.voteAverage < 0.5)) {
    return { exclude: true, reason: `Excluded: Unrated or rating below 5% (Votes: ${tmdbMeta.voteCount})` };
  }

  const genres = (tmdbMeta.genres || []).map(g => g.toLowerCase());
  const lang = (tmdbMeta.originalLanguage || "").toLowerCase();
  const networks = (tmdbMeta.networks || []).map(n => n.toLowerCase());
  const keywords = (tmdbMeta.keywords || []).map(k => k.toLowerCase());
  const lowerOverview = (tmdbMeta.details.overview || "").toLowerCase();

  // 3. Language & Foreign Script Checks
  if (lang !== "en") {
    return { exclude: true, reason: `Excluded: Non-English language ('${lang}')` };
  }

  const nonEnglishCharRegex = /[\u4e00-\u9fa5\u3040-\u30ff\u3130-\u318f\u0400-\u04ff]/;
  if (nonEnglishCharRegex.test(showName)) {
    return { exclude: true, reason: `Excluded: Contains foreign script (${showName})` };
  }

  // 4. Blocked Networks
  const blockedNetworks = [
    "iqiyi", "bilibili", "wavve", "youku", "tencent qq", "vivaone",
    "premier", "смотрим", "кион", "geo entertainment", "tokyo mx"
  ];
  if (networks.some(net => blockedNetworks.some(b => net.includes(b)))) {
    return { exclude: true, reason: `Excluded: Blocked Network (${networks.join(", ")})` };
  }

  // 5. Professional Wrestling Exclusion
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

  // 6. Exclude Vertical Short Dramas / Micro-Series patterns
  if (
    name.includes("san pito pato") ||
    name.includes("dragon baby") ||
    name.includes("mayday for my devil") ||
    lowerOverview.includes("vertical drama") ||
    lowerOverview.includes("short drama") ||
    (name.includes("devil") && lowerOverview.includes("billionaire"))
  ) {
    return { exclude: true, reason: "Excluded: Vertical short-drama / micro-series pattern" };
  }

  // 7. Allowed Reality / Renovation / Game Shows
  const allowedGenres = ["panel", "quiz", "game show", "game-show", "reality", "home improvement", "renovation"];
  if (
    genres.some(g => allowedGenres.some(a => g.includes(a))) ||
    name.includes("zombie") ||
    name.includes("beach")
  ) {
    return { exclude: false, reason: "Allowed Reality/Renovation Content" };
  }

  // 8. Excluded Categories (Sports, News, Talk, Pure Documentary)
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
  const startedAt = Date.now();
  const discoveredShows = new Map();

  console.log(`Discovering English adult shows from TMDB (${LOOKAHEAD_DAYS}-day lookahead + ${RETENTION_DAYS_BACK}-day window)...`);
  if (!STREAM_ADDON_URL) {
    console.warn("⚠️ STREAM_ADDON_URL not set — skipping live stream availability checks.");
  }

  const todayStr = pacificDateString(new Date());
  const maxFutureDate = new Date();
  maxFutureDate.setDate(maxFutureDate.getDate() + LOOKAHEAD_DAYS);
  const maxFutureStr = pacificDateString(maxFutureDate);

  const dayOffsets = [];
  for (let i = -LOOKAHEAD_DAYS; i < RETENTION_DAYS_BACK; i++) {
    dayOffsets.push(i);
  }

  await mapWithConcurrency(dayOffsets, 6, async (i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = pacificDateString(d);

    let page = 1;
    let totalPages = 1;

    do {
      const discoverUrl = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&air_date.gte=${dateStr}&air_date.lte=${dateStr}&with_original_language=en&sort_by=popularity.desc&page=${page}`;
      const data = await fetchJSON(discoverUrl, 6000);

      if (data?.results) {
        totalPages = Math.min(data.total_pages || 1, 10);
        for (const show of data.results) {
          if (!discoveredShows.has(show.id)) {
            discoveredShows.set(show.id, dateStr);
          }
        }
      }
      page++;
    } while (page <= totalPages);
  });

  const candidates = Array.from(discoveredShows.entries());
  console.log(`Discovered ${candidates.length} unique candidate shows in ${((Date.now() - startedAt) / 1000).toFixed(1)}s. Evaluating metadata...`);

  const evaluated = await mapWithConcurrency(candidates, 8, async ([tmdbId, discoveredDate], idx) => {
    if ((idx + 1) % 50 === 0 || idx + 1 === candidates.length) {
      console.log(`Metadata progress: ${idx + 1}/${candidates.length} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    }

    const tmdbMeta = await getTmdbMetadata(tmdbId);
    if (!tmdbMeta) return null;

    const showName = tmdbMeta.details.name;
    const audit = evaluateExclusion(tmdbId, showName, tmdbMeta);

    if (audit.exclude) {
      auditLogs.push({ name: showName, status: "DROPPED BY FILTER", detail: audit.reason });
      return null;
    }

    const imdbId = tmdbMeta.imdbId || null;
    const stremioId = `tmdb:${tmdbId}`;
    const tmdbDetails = tmdbMeta.details;

    const lastEp = tmdbDetails.last_episode_to_air;
    const nextEp = tmdbDetails.next_episode_to_air;
    const lastEpDate = lastEp?.air_date || "";
    const nextEpDate = nextEp?.air_date || "";

    // Base sort date starts at discoveredDate, but never lets an unconfirmed future date outrank today
    let sortDate = discoveredDate > todayStr ? todayStr : discoveredDate;
    if (lastEpDate && lastEpDate > sortDate && lastEpDate <= todayStr) {
      sortDate = lastEpDate;
    }

    const hasUpcomingCandidate =
      Boolean(STREAM_ADDON_URL && imdbId && nextEp && nextEpDate >= todayStr && nextEpDate <= maxFutureStr);

    return {
      tmdbId,
      showName,
      audit,
      imdbId,
      stremioId,
      tmdbDetails,
      tmdbMeta,
      lastEpDate,
      nextEpDate,
      sortDate,
      hasUpcomingCandidate,
      nextSeason: nextEp?.season_number,
      nextEpisode: nextEp?.episode_number,
      streamVerified: false
    };
  });

  const activeCandidates = evaluated.filter(Boolean);
  const streamCheckTargets = activeCandidates.filter(item => item.hasUpcomingCandidate);

  console.log(`Checking live streams for ${streamCheckTargets.length} upcoming candidates (concurrency=4, timeout=2500ms)...`);

  await mapWithConcurrency(streamCheckTargets, 4, async (item) => {
    const liveNow = await hasLiveStreams(item.imdbId, item.nextSeason, item.nextEpisode);
    if (liveNow) {
      // Confirmed early drop or live stream: promote straight to today
      item.sortDate = todayStr;
      item.streamVerified = true;
    } else if (item.nextEpDate === todayStr) {
      // Airing officially today
      item.sortDate = todayStr;
    } else {
      // Future episode has no live streams yet: keep demoted to last aired episode (or earlier)
      const fallbackDate = item.lastEpDate && item.lastEpDate <= todayStr
        ? item.lastEpDate
        : (item.sortDate <= todayStr ? item.sortDate : todayStr);
      item.sortDate = fallbackDate > todayStr ? todayStr : fallbackDate;
    }
  });

  const metas = activeCandidates.map((item) => {
    // Hard safety guard so unverified items never get a sort date ahead of todayStr
    const finalSortDate = (!item.streamVerified && item.sortDate > todayStr)
      ? ((item.lastEpDate && item.lastEpDate <= todayStr) ? item.lastEpDate : todayStr)
      : item.sortDate;

    auditLogs.push({
      name: item.showName,
      status: "KEPT",
      sortDate: finalSortDate,
      liveStream: item.streamVerified ? "YES (Promoted)" : "-",
      detail: item.audit.reason
    });

    return {
      id: item.stremioId,
      imdb_id: item.imdbId || undefined,
      tmdb_id: item.tmdbId,
      type: "series",
      name: item.showName,
      genres: item.tmdbMeta.genres,
      year: item.tmdbDetails.first_air_date ? item.tmdbDetails.first_air_date.split("-")[0] : undefined,
      description: item.tmdbDetails.overview || "",
      poster: item.tmdbDetails.poster_path ? `https://image.tmdb.org/t/p/original${item.tmdbDetails.poster_path}` : null,
      background: item.tmdbDetails.backdrop_path ? `https://image.tmdb.org/t/p/original${item.tmdbDetails.backdrop_path}` : null,
      _sortDate: finalSortDate
    };
  });

  metas.sort((a, b) => b._sortDate.localeCompare(a._sortDate));
  metas.forEach(show => { delete show._sortDate; });

  if (!fs.existsSync(CATALOG_DIR)) fs.mkdirSync(CATALOG_DIR, { recursive: true });
  const filePath = path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json");
  fs.writeFileSync(filePath, JSON.stringify({ metas }, null, 2));

  console.log("\n=================================================================================");
  console.log("            TMDB DAILY ADULT DISCOVERY REPORT SUMMARY                            ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
  console.log(`Successfully generated ${metas.length} adult shows in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}

build().catch(err => { console.error(err); process.exit(1); });
