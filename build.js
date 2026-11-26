/**
 * build.js — Stremio & Wako compatible static catalog + meta generator
 * TMDB Daily Discover + Next-Episode.net dates
 * Dates come strictly from next-episode.net (no TMDB air_date usage).
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
const META_DIR = path.join(__dirname, "meta", "series");
const LOOKAHEAD_DAYS = 3;
const RETENTION_DAYS_BACK = 9;
const NEXT_EPISODE_DELAY_MS = 350;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidYmd(str) {
  return typeof str === "string" && /^\d{4}-\d{2}-\d{2}$/.test(str);
}

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

async function fetchNextEpisodeHTML(url, timeoutMs = 8000, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
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

      if (res.status === 429 && attempt < retries) {
        await sleep(1500 * (attempt + 1));
        continue;
      }

      const text = await res.text();
      return res.ok ? text : null;
    } catch {
      if (attempt < retries) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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

function addDaysYmd(ymdStr, deltaDays) {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function toIsoMidnight(dateStr) {
  if (!isValidYmd(dateStr)) return undefined;
  return `${dateStr}T00:00:00.000Z`;
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
  const ymd = `${year}-${monthNum}-${day}`;
  return isValidYmd(ymd) ? ymd : null;
}

function htmlToPlainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#?\w+;/gi, " ")
    .replace(/\s+/g, " ");
}

/**
 * Extracts Next-Episode.net dates and Season/Episode mappings strictly from next-episode.net HTML.
 */
function parseNextEpisodeScheduleHtml(html, cutoffDate) {
  if (!html) return { primaryDate: "", episodeDateMap: new Map() };

  const plainText = htmlToPlainText(html);
  const episodeDateMap = new Map();

  const dateRegex = /\bDate\s*:?\s*((?:[A-Za-z]{3}\s+)?[A-Za-z]{3}\s+\d{1,2},\s+\d{4})\b/gi;
  const allDatesSet = new Set();

  for (const m of plainText.matchAll(dateRegex)) {
    const ymd = parseNextEpisodeDateText(m[1]);
    if (!isValidYmd(ymd)) continue;
    allDatesSet.add(ymd);

    const idx = m.index ?? 0;
    const windowStart = Math.max(0, idx - 220);
    const windowEnd = Math.min(plainText.length, idx + m[0].length + 220);
    const context = plainText.slice(windowStart, windowEnd);

    const seMatch =
      context.match(/\bSeason\s*:?\s*(\d{1,2})\b[\s\S]{0,80}?\bEpisode\s*:?\s*(\d{1,2})\b/i) ||
      context.match(/\bS(\d{1,2})\s*E(\d{1,2})\b/i) ||
      context.match(/\b(\d{1,2})x(\d{1,2})\b/i);

    if (seMatch) {
      const season = Number(seMatch[1]);
      const episode = Number(seMatch[2]);
      if (season > 0 && episode > 0 && !episodeDateMap.has(`${season}:${episode}`)) {
        episodeDateMap.set(`${season}:${episode}`, ymd);
      }
    }
  }

  const allDates = [...allDatesSet].sort((a, b) => b.localeCompare(a));
  if (allDates.length === 0) {
    return { primaryDate: "", episodeDateMap };
  }

  const pastOrToday = allDates.find(d => d <= cutoffDate);
  if (pastOrToday) {
    return { primaryDate: pastOrToday, episodeDateMap };
  }

  const upcomingSorted = [...allDates].sort((a, b) => a.localeCompare(b));
  return { primaryDate: upcomingSorted[0], episodeDateMap };
}

async function getNextEpisodeScheduleData(showName, cutoffDate) {
  const slugs = toNextEpisodeSlugs(showName);
  if (slugs.length === 0) return { primaryDate: "", episodeDateMap: new Map() };

  for (const slug of slugs) {
    await sleep(NEXT_EPISODE_DELAY_MS);
    const directHtml = await fetchNextEpisodeHTML(`https://next-episode.net/${slug}`);
    const parsed = parseNextEpisodeScheduleHtml(directHtml, cutoffDate);
    if (parsed.primaryDate) return parsed;
  }

  const ignoredPaths = new Set([
    "browse", "calendar", "login", "register", "search", "news",
    "trailers", "top", "popular", "recent", "privacy", "terms", "contact", "faq", "premium"
  ]);

  await sleep(NEXT_EPISODE_DELAY_MS);
  const searchUrl = `https://next-episode.net/search/?name=${encodeURIComponent(showName)}`;
  const searchHtml = await fetchNextEpisodeHTML(searchUrl);
  if (!searchHtml) return { primaryDate: "", episodeDateMap: new Map() };

  const searchParsed = parseNextEpisodeScheduleHtml(searchHtml, cutoffDate);
  if (searchParsed.primaryDate) return searchParsed;

  const hrefMatches = [...searchHtml.matchAll(/href=["']\/([a-z0-9-]+)["']/gi)]
    .map(m => m[1].toLowerCase())
    .filter(p => !ignoredPaths.has(p) && !slugs.includes(p));

  const uniquePaths = [...new Set(hrefMatches)].slice(0, 2);
  for (const candidatePath of uniquePaths) {
    await sleep(NEXT_EPISODE_DELAY_MS);
    const matchedHtml = await fetchNextEpisodeHTML(`https://next-episode.net/${candidatePath}`);
    const matchedParsed = parseNextEpisodeScheduleHtml(matchedHtml, cutoffDate);
    if (matchedParsed.primaryDate) return matchedParsed;
  }

  return { primaryDate: "", episodeDateMap: new Map() };
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

/**
 * Builds Stremio videos using ONLY next-episode.net dates (zero TMDB air_date usage).
 */
async function buildSeriesVideos(tmdbId, stremioId, tmdbDetails, nextEpisodeData) {
  const seasons = Array.isArray(tmdbDetails.seasons)
    ? tmdbDetails.seasons
        .filter(s => typeof s.season_number === "number" && s.season_number > 0)
        .sort((a, b) => a.season_number - b.season_number)
    : [];

  const seasonPayloads = await Promise.all(
    seasons.map(s =>
      fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${s.season_number}?api_key=${TMDB_API_KEY}`)
    )
  );

  const episodeDateMap = nextEpisodeData?.episodeDateMap || new Map();
  const primaryDate = nextEpisodeData?.primaryDate || "";

  const videos = [];
  for (const seasonData of seasonPayloads) {
    if (!seasonData || !Array.isArray(seasonData.episodes)) continue;
    for (const ep of seasonData.episodes) {
      if (typeof ep.episode_number !== "number") continue;
      const key = `${seasonData.season_number}:${ep.episode_number}`;
      const neYmd = episodeDateMap.get(key) || "";
      videos.push({
        id: `${stremioId}:${seasonData.season_number}:${ep.episode_number}`,
        title: ep.name || `Episode ${ep.episode_number}`,
        season: seasonData.season_number,
        episode: ep.episode_number,
        released: toIsoMidnight(neYmd),
        overview: ep.overview || undefined,
        thumbnail: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : undefined
      });
    }
  }

  if (isValidYmd(primaryDate) && videos.length > 0) {
    const primaryIso = toIsoMidnight(primaryDate);
    if (!videos.some(v => v.released === primaryIso)) {
      videos[videos.length - 1].released = primaryIso;
    }
  }

  return videos;
}

// ---------------------------------------------------------------------------------
// EXCLUSION & FILTER LOGIC
// ---------------------------------------------------------------------------------
function evaluateExclusion(tmdbId, showName, tmdbMeta) {
  const name = (showName || "").toLowerCase();

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

  if (lang !== "en") {
    return { exclude: true, reason: `Excluded: Non-English language ('${lang}')`, whitelisted: false };
  }

  const nonEnglishCharRegex = /[\u4e00-\u9fa5\u3040-\u30ff\u3130-\u318f\u0400-\u04ff]/;
  if (nonEnglishCharRegex.test(showName)) {
    return { exclude: true, reason: `Excluded: Contains foreign script (${showName})`, whitelisted: false };
  }

  const blockedNetworks = [
    "iqiyi", "bilibili", "wavve", "youku", "tencent qq", "vivaone",
    "premier", "смотрим", "кион", "geo entertainment", "tokyo mx"
  ];
  if (networks.some(net => blockedNetworks.some(b => net.includes(b)))) {
    return { exclude: true, reason: `Excluded: Blocked Network (${networks.join(", ")})`, whitelisted: false };
  }

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

  const allowedGenres = ["panel", "quiz", "game show", "game-show", "reality", "home improvement", "renovation"];
  if (
    genres.some(g => allowedGenres.some(a => g.includes(a))) ||
    name.includes("zombie") ||
    name.includes("beach")
  ) {
    return { exclude: false, reason: "Allowed Reality/Renovation Content", whitelisted: false };
  }

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

function writeMetaFiles(stremioId, metaObj) {
  const payload = JSON.stringify({ meta: metaObj }, null, 2);
  const rawPath = path.join(META_DIR, `${stremioId}.json`);
  const encodedPath = path.join(META_DIR, `${encodeURIComponent(stremioId)}.json`);

  fs.writeFileSync(rawPath, payload);
  if (encodedPath !== rawPath) {
    fs.writeFileSync(encodedPath, payload);
  }
}

async function build() {
  const startedAt = Date.now();
  const discoveredIds = new Set();
  const todayStr = pacificDateString();

  console.log(`Discovering English shows from TMDB (${LOOKAHEAD_DAYS}-day lookahead + ${RETENTION_DAYS_BACK}-day window)...`);

  const targetDates = [];
  for (let offset = -RETENTION_DAYS_BACK; offset <= LOOKAHEAD_DAYS; offset++) {
    targetDates.push(addDaysYmd(todayStr, offset));
  }

  await mapWithConcurrency(targetDates, 6, async (dateStr) => {
    let page = 1;
    let totalPages = 1;

    do {
      const discoverUrl = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&air_date.gte=${dateStr}&air_date.lte=${dateStr}&with_original_language=en&sort_by=popularity.desc&page=${page}`;
      const data = await fetchJSON(discoverUrl, 6000);

      if (data?.results) {
        totalPages = Math.min(data.total_pages || 1, 10);
        for (const show of data.results) {
          discoveredIds.add(show.id);
        }
      }
      page++;
    } while (page <= totalPages);
  });

  const candidates = Array.from(discoveredIds);
  console.log(`Discovered ${candidates.length} unique candidate shows in ${((Date.now() - startedAt) / 1000).toFixed(1)}s. Evaluating metadata...`);

  const filteredCandidates = [];
  await mapWithConcurrency(candidates, 6, async (tmdbId, idx) => {
    if ((idx + 1) % 50 === 0 || idx + 1 === candidates.length) {
      console.log(`TMDB metadata progress: ${idx + 1}/${candidates.length} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    }

    const tmdbMeta = await getTmdbMetadata(tmdbId);
    if (!tmdbMeta) return;

    const showName = tmdbMeta.details.name;
    const audit = evaluateExclusion(tmdbId, showName, tmdbMeta);

    if (audit.exclude) {
      auditLogs.push({ name: showName, status: "DROPPED BY FILTER", detail: audit.reason });
      return;
    }

    filteredCandidates.push({
      tmdbId,
      showName,
      audit,
      imdbId: tmdbMeta.imdbId || null,
      stremioId: `tmdb:${tmdbId}`,
      tmdbDetails: tmdbMeta.details,
      tmdbMeta
    });
  });

  console.log(`Fetching Next Episode dates for ${filteredCandidates.length} kept shows...`);
  const activeCandidates = [];
  for (let i = 0; i < filteredCandidates.length; i++) {
    const item = filteredCandidates[i];
    if ((i + 1) % 25 === 0 || i + 1 === filteredCandidates.length) {
      console.log(`Next Episode progress: ${i + 1}/${filteredCandidates.length} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    }
    const nextEpisodeData = await getNextEpisodeScheduleData(item.showName, todayStr);
    const nextEpisodeDate = isValidYmd(nextEpisodeData.primaryDate) ? nextEpisodeData.primaryDate : "";
    activeCandidates.push({
      ...item,
      nextEpisodeData,
      nextEpisodeDate
    });
  }

  // Sort strictly by next-episode.net date descending; shows without a next-episode.net date sort last
  activeCandidates.sort((a, b) => {
    const aHas = isValidYmd(a.nextEpisodeDate);
    const bHas = isValidYmd(b.nextEpisodeDate);
    if (aHas && bHas) return b.nextEpisodeDate.localeCompare(a.nextEpisodeDate);
    if (aHas) return -1;
    if (bHas) return 1;
    return a.showName.localeCompare(b.showName);
  });

  if (!fs.existsSync(CATALOG_DIR)) fs.mkdirSync(CATALOG_DIR, { recursive: true });
  if (!fs.existsSync(META_DIR)) {
    fs.mkdirSync(META_DIR, { recursive: true });
  } else {
    for (const existingFile of fs.readdirSync(META_DIR)) {
      if (existingFile.endsWith(".json")) {
        fs.unlinkSync(path.join(META_DIR, existingFile));
      }
    }
  }

  console.log(`Generating static meta files for ${activeCandidates.length} shows...`);
  const metas = await mapWithConcurrency(activeCandidates, 6, async (item) => {
    auditLogs.push({
      name: item.showName,
      status: "KEPT",
      nextEpisodeDate: item.nextEpisodeDate || "-",
      detail: item.audit.reason
    });

    const posterDate = item.nextEpisodeDate || undefined;
    const videos = await buildSeriesVideos(
      item.tmdbId,
      item.stremioId,
      item.tmdbDetails,
      item.nextEpisodeData
    );

    const metaObj = {
      id: item.stremioId,
      imdb_id: item.imdbId || undefined,
      tmdb_id: item.tmdbId,
      type: "series",
      name: item.showName,
      genres: item.tmdbMeta.genres,
      releaseInfo: posterDate,
      description: item.tmdbDetails.overview || "",
      poster: item.tmdbDetails.poster_path ? `https://image.tmdb.org/t/p/original${item.tmdbDetails.poster_path}` : null,
      background: item.tmdbDetails.backdrop_path ? `https://image.tmdb.org/t/p/original${item.tmdbDetails.backdrop_path}` : null,
      videos
    };

    writeMetaFiles(item.stremioId, metaObj);

    return {
      id: item.stremioId,
      imdb_id: item.imdbId || undefined,
      tmdb_id: item.tmdbId,
      type: "series",
      name: item.showName,
      genres: item.tmdbMeta.genres,
      releaseInfo: posterDate,
      description: item.tmdbDetails.overview || "",
      poster: item.tmdbDetails.poster_path ? `https://image.tmdb.org/t/p/original${item.tmdbDetails.poster_path}` : null,
      background: item.tmdbDetails.backdrop_path ? `https://image.tmdb.org/t/p/original${item.tmdbDetails.backdrop_path}` : null
    };
  });

  const filePath = path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json");
  fs.writeFileSync(filePath, JSON.stringify({ metas }, null, 2));

  console.log("\n=================================================================================");
  console.log("            TMDB DAILY DISCOVERY REPORT SUMMARY                                ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
  console.log(`Successfully generated ${metas.length} shows and meta files in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}

build().catch(err => { console.error(err); process.exit(1); });
