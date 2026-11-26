/**
 * build.js — Stremio & Wako compatible static adult catalog
 * TMDB Daily Discover (3-Day Lookahead + 9-Day Rolling Window)
 * Sorted strictly by Next Episode (next-episode.net) episode air date descending.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = process.env.TMDB_API_KEY;

if (!TMDB_API_KEY || TMDB_API_KEY.trim() === "") {
  console.error("\n❌ ERROR: TMDB_API_KEY environment variable is not defined or is empty!\n");
  process.exit(1);
}

const CATALOG_DIR = path.join(__dirname, "catalog", "series");
const LOOKAHEAD_DAYS = 3;
const RETENTION_DAYS_BACK = 9;
const DEBUG_NEXT_EPISODE = false;

let nextEpisodeDebugCount = 0;
const auditLogs = [];

const MONTHS = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12"
};

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

async function fetchHTML(url, timeoutMs = 8000, debug = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://next-episode.net/"
      }
    });
    const text = await res.text();
    if (debug) {
      console.log(`[DEBUG] ${url} -> status=${res.status}, finalUrl=${res.url}, len=${text.length}`);
      console.log(`[DEBUG] sample=${text.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    return res.ok ? text : null;
  } catch (err) {
    if (debug) {
      console.log(`[DEBUG] ${url} -> error=${err.message}`);
    }
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

function toNextEpisodeSlugs(title) {
  const base = (title || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, "and")
    .trim();

  const dashed = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const compact = base.replace(/[^a-z0-9]+/g, "");

  return [...new Set([dashed, compact].filter(Boolean))];
}

function parseNextEpisodeDateText(rawDateText) {
  const match = rawDateText.match(/\b(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\b/);
  if (!match) return null;

  const monthNum = MONTHS[match[1].toLowerCase()];
  if (!monthNum) return null;

  const day = match[2].padStart(2, "0");
  const year = match[3];
  return `${year}-${monthNum}-${day}`;
}

function extractDatesFromNextEpisodeHtml(html, cutoffDate, debug = false) {
  if (!html) return "";

  const plainText = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#?\w+;/gi, " ")
    .replace(/\s+/g, " ");

  if (debug) {
    const aroundNov = [...plainText.matchAll(/.{0,35}\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b.{0,35}/gi)]
      .slice(0, 8)
      .map(m => m[0].trim());
    console.log("[DEBUG] month snippets:", aroundNov);
  }

  const dateMatches = [
    ...plainText.matchAll(/\bDate\s*:?\s*((?:[A-Za-z]{3}\s+)?[A-Za-z]{3}\s+\d{1,2},\s+\d{4})\b/gi)
  ];

  const parsedDates = dateMatches
    .map(m => parseNextEpisodeDateText(m[1]))
    .filter(d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a));

  if (parsedDates.length === 0) return "";

  const upToCutoff = parsedDates.find(d => d <= cutoffDate);
  return upToCutoff || parsedDates[parsedDates.length - 1] || "";
}

async function getNextEpisodeDate(showName, cutoffDate) {
  const slugs = toNextEpisodeSlugs(showName);
  if (slugs.length === 0) return "";

  const shouldDebug = DEBUG_NEXT_EPISODE && nextEpisodeDebugCount < 3;
  if (shouldDebug) nextEpisodeDebugCount++;

  for (const slug of slugs) {
    const directHtml = await fetchHTML(`https://next-episode.net/${slug}`, 8000, shouldDebug);
    const directDate = extractDatesFromNextEpisodeHtml(directHtml, cutoffDate, shouldDebug);
    if (directDate) return directDate;
  }

  const ignoredPaths = new Set([
    "browse", "calendar", "login", "register", "search", "news",
    "trailers", "top", "popular", "recent", "privacy", "terms", "contact", "faq"
  ]);

  const searchUrl = `https://next-episode.net/search/?name=${encodeURIComponent(showName)}`;
  const searchHtml = await fetchHTML(searchUrl, 8000, shouldDebug);
  if (!searchHtml) return "";

  const searchPageDate = extractDatesFromNextEpisodeHtml(searchHtml, cutoffDate, shouldDebug);
  if (searchPageDate) return searchPageDate;

  const hrefMatches = [...searchHtml.matchAll(/href=["']\/([a-z0-9-]+)["']/gi)]
    .map(m => m[1].toLowerCase())
    .filter(p => !ignoredPaths.has(p) && !slugs.includes(p));

  const uniquePaths = [...new Set(hrefMatches)].slice(0, 3);
  for (const candidatePath of uniquePaths) {
    const matchedHtml = await fetchHTML(`https://next-episode.net/${candidatePath}`, 8000, shouldDebug);
    const matchedDate = extractDatesFromNextEpisodeHtml(matchedHtml, cutoffDate, shouldDebug);
    if (matchedDate) return matchedDate;
  }

  return "";
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
    genres: Array.isArray(details.genres) ? details.genres.map(g => g?.name).filter(Boolean) : [],
    keywords: Array.isArray(kwList) ? kwList.map(k => k?.name).filter(Boolean) : [],
    originalLanguage: details.original_language,
    networks: Array.isArray(details.networks) ? details.networks.map(n => n?.name).filter(Boolean) : [],
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
    return { exclude: false, reason: "Whitelisted Override", whitelisted: true };
  }

  // 2. User Rating Check: Exclude unrated (0 votes) or ratings below 5%
  if (tmdbMeta.voteCount === 0 || (tmdbMeta.voteAverage !== null && tmdbMeta.voteAverage < 0.5)) {
    return { exclude: true, reason: `Excluded: Unrated or rating below 5% (Votes: ${tmdbMeta.voteCount})`, whitelisted: false };
  }

  const genres = (tmdbMeta.genres || [])
    .map(g => (typeof g === "string" ? g : g?.name || ""))
    .filter(Boolean)
    .map(g => g.toLowerCase());

  const lang = (tmdbMeta.originalLanguage || "").toLowerCase();

  const networks = (tmdbMeta.networks || [])
    .map(n => (typeof n === "string" ? n : n?.name || ""))
    .filter(Boolean)
    .map(n => n.toLowerCase());

  const keywords = (tmdbMeta.keywords || [])
    .map(k => (typeof k === "string" ? k : k?.name || ""))
    .filter(Boolean)
    .map(k => k.toLowerCase());

  const lowerOverview = (tmdbMeta.details.overview || "").toLowerCase();

  // 3. Language & Foreign Script Checks
  if (lang !== "en") {
    return { exclude: true, reason: `Excluded: Non-English language ('${lang}')`, whitelisted: false };
  }

  const nonEnglishCharRegex = /[\u4e00-\u9fa5\u3040-\u30ff\u3130-\u318f\u0400-\u04ff]/;
  if (nonEnglishCharRegex.test(showName)) {
    return { exclude: true, reason: `Excluded: Contains foreign script (${showName})`, whitelisted: false };
  }

  // 4. Blocked Networks
  const blockedNetworks = [
    "iqiyi", "bilibili", "wavve", "youku", "tencent qq", "vivaone",
    "premier", "смотрим", "кион", "geo entertainment", "tokyo mx"
  ];
  if (networks.some(net => blockedNetworks.some(b => net.includes(b)))) {
    return { exclude: true, reason: `Excluded: Blocked Network (${networks.join(", ")})`, whitelisted: false };
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
    return { exclude: true, reason: `Excluded: Professional Wrestling (${showName})`, whitelisted: false };
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
    return { exclude: true, reason: "Excluded: Vertical short-drama / micro-series pattern", whitelisted: false };
  }

  // 7. Allowed Reality / Renovation / Game Shows
  const allowedGenres = ["panel", "quiz", "game show", "game-show", "reality", "home improvement", "renovation"];
  if (
    genres.some(g => allowedGenres.some(a => g.includes(a))) ||
    name.includes("zombie") ||
    name.includes("beach")
  ) {
    return { exclude: false, reason: "Allowed Reality/Renovation Content", whitelisted: false };
  }

  // 8. Excluded Categories (Sports, News, Talk, Pure Documentary)
  if (genres.some(g => g.includes("sports"))) {
    return { exclude: true, reason: "Excluded: Sports", whitelisted: false };
  }
  if (genres.some(g => g.includes("news") || g.includes("talk"))) {
    return { exclude: true, reason: "Excluded: News/Talk", whitelisted: false };
  }
  if (genres.some(g => g === "documentary")) {
    return { exclude: true, reason: "Excluded: Pure Documentary", whitelisted: false };
  }

  return { exclude: false, reason: "Passed general rules", whitelisted: false };
}

async function build() {
  const startedAt = Date.now();
  const discoveredShows = new Map();
  const todayStr = pacificDateString();

  console.log(`Discovering English adult shows from TMDB (${LOOKAHEAD_DAYS}-day lookahead + ${RETENTION_DAYS_BACK}-day window)...`);

  const now = new Date();
  const dayOffsets = [];
  for (let i = -LOOKAHEAD_DAYS; i < RETENTION_DAYS_BACK; i++) {
    dayOffsets.push(i);
  }

  await mapWithConcurrency(dayOffsets, 6, async (i) => {
    const d = new Date(now);
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

  const evaluated = await mapWithConcurrency(candidates, 3, async ([tmdbId], idx) => {
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

    // Fetch episode air date strictly from next-episode.net
    const episodeDate = await getNextEpisodeDate(showName, todayStr);

    return {
      tmdbId,
      showName,
      audit,
      imdbId,
      stremioId,
      tmdbDetails,
      tmdbMeta,
      episodeDate
    };
  });

  const activeCandidates = evaluated.filter(Boolean);

  activeCandidates.sort((a, b) => b.episodeDate.localeCompare(a.episodeDate));

  const metas = activeCandidates.map((item) => {
    auditLogs.push({
      name: item.showName,
      status: "KEPT",
      episodeDate: item.episodeDate || "-",
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
      background: item.tmdbDetails.backdrop_path ? `https://image.tmdb.org/t/p/original${item.tmdbDetails.backdrop_path}` : null
    };
  });

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
