/**
 * build.js — Stremio & Wako compatible static catalog + meta generator
 * TMDB Daily Discover + epguides.frecar.no dates with persistent JSON cache
 * All episode dates come strictly from epguides.frecar.no (zero TMDB air_date usage).
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
const CACHE_DIR = path.join(__dirname, "cache");
const DATE_CACHE_FILE = path.join(CACHE_DIR, "epguides-airdates.json");

const EPGUIDES_BASE = "https://epguides.frecar.no";
const LOOKAHEAD_DAYS = 3;
const RETENTION_DAYS_BACK = 9;
const EPGUIDES_CONCURRENCY = 4;
const EPGUIDES_DELAY_MS = 120;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Set to a show name (e.g. "Stick") to debug a single show, or "" for full run
const DEBUG_ONLY_SHOW = "";

const auditLogs = [];
const jsonCache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidYmd(str) {
  return typeof str === "string" && /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function normalizeDateYmd(rawVal) {
  if (!rawVal) return null;
  const s = String(rawVal).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const isoPrefix = s.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  if (isoPrefix) return isoPrefix[1];

  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) {
    return dt.toISOString().slice(0, 10);
  }
  return null;
}

async function fetchJSON(url, timeoutMs = 7000, retries = 1) {
  if (jsonCache.has(url)) {
    return jsonCache.get(url);
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });

      if (res.status === 404) {
        jsonCache.set(url, null);
        return null;
      }

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }

      if (!res.ok) {
        jsonCache.set(url, null);
        return null;
      }

      const data = await res.json();
      jsonCache.set(url, data);
      return data;
    } catch {
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      jsonCache.set(url, null);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  jsonCache.set(url, null);
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

function loadPersistentDateCache() {
  try {
    if (!fs.existsSync(DATE_CACHE_FILE)) return {};
    const raw = fs.readFileSync(DATE_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savePersistentDateCache(cacheObj) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  fs.writeFileSync(DATE_CACHE_FILE, JSON.stringify(cacheObj, null, 2));
}

function isCacheEntryFresh(entry, nowMs = Date.now()) {
  if (!entry || typeof entry.fetchedAt !== "number") return false;
  const age = nowMs - entry.fetchedAt;
  if (entry.miss) return age < MISS_TTL_MS;
  return age < CACHE_TTL_MS;
}

function normalizeTitle(str) {
  return (str || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toEpguidesSlugs(title) {
  const raw = (title || "").trim();
  if (!raw) return [];

  const noParens = raw.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const noLeadingArticle = raw.replace(/^(the|a|an)\s+/i, "").trim();
  const cleanCombo = noParens.replace(/^(the|a|an)\s+/i, "").trim();

  const variants = [raw, noParens, noLeadingArticle, cleanCombo];
  const slugs = [];

  for (const v of variants) {
    if (!v) continue;
    const compact = v.replace(/['’]/g, "").replace(/[^a-zA-Z0-9]+/g, "");
    const dashed = v.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (compact) slugs.push(compact);
    if (dashed && dashed.toLowerCase() !== compact.toLowerCase()) slugs.push(dashed);
  }

  return [...new Set(slugs)];
}

function pickPrimaryDate(allDatesAsc, cutoffDate, latestSeasonDatesAsc = []) {
  const pool = latestSeasonDatesAsc.length > 0 ? latestSeasonDatesAsc : allDatesAsc;
  if (!Array.isArray(pool) || pool.length === 0) return "";
  const pastOrToday = [...pool].reverse().find(d => d <= cutoffDate);
  if (pastOrToday) return pastOrToday;
  return pool[0];
}

function parseEpisodesPayload(payload) {
  const episodeDateMap = new Map();
  let highestSeason = 0;
  const seasonDates = new Map();
  const allDatesSet = new Set();

  if (!payload || typeof payload !== "object") {
    return { episodeDateMap, allDates: [], latestSeasonDatesAsc: [] };
  }

  const rawList = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.episodes)
      ? payload.episodes
      : payload.episodes && typeof payload.episodes === "object"
        ? Object.values(payload.episodes).flat()
        : Array.isArray(payload.data)
          ? payload.data
          : [];

  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;

    const season = Number(
      item.season ?? item.season_number ?? item.seasonNumber ?? item.s ?? 0
    );
    const episode = Number(
      item.episode ?? item.episode_number ?? item.episodeNumber ?? item.number ?? item.e ?? 0
    );
    const rawDate =
      item.airdate ?? item.air_date ?? item.release_date ?? item.releaseDate ?? item.date ?? null;
    const ymd = normalizeDateYmd(rawDate);

    if (!isValidYmd(ymd)) continue;
    allDatesSet.add(ymd);

    if (season > 0 && episode > 0) {
      episodeDateMap.set(`${season}:${episode}`, ymd);
      if (season > highestSeason) highestSeason = season;
      if (!seasonDates.has(season)) seasonDates.set(season, new Set());
      seasonDates.get(season).add(ymd);
    }
  }

  const allDates = [...allDatesSet].sort((a, b) => a.localeCompare(b));
  const latestSeasonDatesAsc = highestSeason > 0 && seasonDates.has(highestSeason)
    ? [...seasonDates.get(highestSeason)].sort((a, b) => a.localeCompare(b))
    : [];

  return { episodeDateMap, allDates, latestSeasonDatesAsc };
}

function extractSearchSlugs(searchPayload, showName) {
  if (!searchPayload) return [];
  const list = Array.isArray(searchPayload)
    ? searchPayload
    : Array.isArray(searchPayload.results)
      ? searchPayload.results
      : Array.isArray(searchPayload.shows)
        ? searchPayload.shows
        : [];

  const targetNorm = normalizeTitle(showName);
  const scored = [];

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const slug = entry.slug || entry.show?.slug || entry.id || entry.code || "";
    const title = entry.title || entry.name || entry.show?.title || entry.show?.name || "";
    if (!slug) continue;

    const titleNorm = normalizeTitle(title);
    let score = 1;
    if (titleNorm && targetNorm) {
      if (titleNorm === targetNorm) score += 5;
      else if (titleNorm.includes(targetNorm) || targetNorm.includes(titleNorm)) score += 2;
    }
    scored.push({ slug: String(slug), score });
  }

  scored.sort((a, b) => b.score - a.score);
  return [...new Set(scored.map(s => s.slug))].slice(0, 3);
}

async function fetchEpguidesScheduleData(showName, cutoffDate, persistentCache, forceRefresh = false) {
  const cacheKey = normalizeTitle(showName) || showName.toLowerCase();
  const cached = persistentCache[cacheKey];

  if (!forceRefresh && isCacheEntryFresh(cached)) {
    const episodeDateMap = new Map(Object.entries(cached.episodes || {}));
    const allDates = Array.isArray(cached.allDates) ? cached.allDates : [];
    const latestSeasonDatesAsc = Array.isArray(cached.latestSeasonDatesAsc) ? cached.latestSeasonDatesAsc : [];
    const primaryDate = cached.miss
      ? ""
      : (isValidYmd(cached.primaryDate) ? cached.primaryDate : pickPrimaryDate(allDates, cutoffDate, latestSeasonDatesAsc));

    if (DEBUG_ONLY_SHOW) {
      console.log(`[CACHE HIT] "${showName}" -> primaryDate=${primaryDate || "-"} episodes=${episodeDateMap.size}`);
    }
    return { primaryDate, allDates, episodeDateMap, fromCache: true };
  }

  const slugs = toEpguidesSlugs(showName);
  let resolved = null;

  for (const slug of slugs) {
    await sleep(EPGUIDES_DELAY_MS);
    const url = `${EPGUIDES_BASE}/shows/${encodeURIComponent(slug)}/episodes`;
    if (DEBUG_ONLY_SHOW) console.log(`[EPGUIDES TRY] ${url}`);
    const payload = await fetchJSON(url);
    const parsed = parseEpisodesPayload(payload);
    if (parsed.episodeDateMap.size > 0 || parsed.allDates.length > 0) {
      resolved = parsed;
      break;
    }
  }

  if (!resolved) {
    await sleep(EPGUIDES_DELAY_MS);
    const searchUrl = `${EPGUIDES_BASE}/shows/search?query=${encodeURIComponent(showName)}`;
    if (DEBUG_ONLY_SHOW) console.log(`[EPGUIDES SEARCH] ${searchUrl}`);
    const searchData = await fetchJSON(searchUrl);
    const candidateSlugs = extractSearchSlugs(searchData, showName);

    for (const candSlug of candidateSlugs) {
      if (slugs.includes(candSlug)) continue;
      await sleep(EPGUIDES_DELAY_MS);
      const url = `${EPGUIDES_BASE}/shows/${encodeURIComponent(candSlug)}/episodes`;
      if (DEBUG_ONLY_SHOW) console.log(`[EPGUIDES CAND] ${url}`);
      const payload = await fetchJSON(url);
      const parsed = parseEpisodesPayload(payload);
      if (parsed.episodeDateMap.size > 0 || parsed.allDates.length > 0) {
        resolved = parsed;
        break;
      }
    }
  }

  if (!resolved) {
    persistentCache[cacheKey] = {
      showName,
      miss: true,
      primaryDate: "",
      allDates: [],
      latestSeasonDatesAsc: [],
      episodes: {},
      fetchedAt: Date.now()
    };
    return { primaryDate: "", allDates: [], episodeDateMap: new Map(), fromCache: false };
  }

  const primaryDate = pickPrimaryDate(resolved.allDates, cutoffDate, resolved.latestSeasonDatesAsc);
  const episodesObj = {};
  for (const [k, v] of resolved.episodeDateMap.entries()) {
    episodesObj[k] = v;
  }

  persistentCache[cacheKey] = {
    showName,
    miss: false,
    primaryDate,
    allDates: resolved.allDates,
    latestSeasonDatesAsc: resolved.latestSeasonDatesAsc,
    episodes: episodesObj,
    fetchedAt: Date.now()
  };

  return {
    primaryDate,
    allDates: resolved.allDates,
    episodeDateMap: resolved.episodeDateMap,
    fromCache: false
  };
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
 * Builds Stremio videos using epguides.frecar.no episodeDateMap.
 */
async function buildSeriesVideos(tmdbId, stremioId, tmdbDetails, scheduleData) {
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

  const episodeDateMap = scheduleData?.episodeDateMap || new Map();
  const fallbackDate = isValidYmd(scheduleData?.primaryDate) ? scheduleData.primaryDate : "";

  const videos = [];
  for (const seasonData of seasonPayloads) {
    if (!seasonData || !Array.isArray(seasonData.episodes)) continue;
    for (const ep of seasonData.episodes) {
      if (typeof ep.episode_number !== "number") continue;
      const key = `${seasonData.season_number}:${ep.episode_number}`;
      const epDate = episodeDateMap.get(key) || fallbackDate;
      videos.push({
        id: `${stremioId}:${seasonData.season_number}:${ep.episode_number}`,
        title: ep.name || `Episode ${ep.episode_number}`,
        season: seasonData.season_number,
        episode: ep.episode_number,
        released: toIsoMidnight(epDate),
        overview: ep.overview || undefined,
        thumbnail: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : undefined
      });
    }
  }

  return videos;
}

function evaluateExclusion(tmdbId, showName, tmdbMeta) {
  const name = (showName || "").toLowerCase();

  const whitelistedIds = [1554, 312415];
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
  const persistentCache = loadPersistentDateCache();

  if (DEBUG_ONLY_SHOW) {
    const data = await fetchEpguidesScheduleData(DEBUG_ONLY_SHOW, todayStr, persistentCache, true);
    savePersistentDateCache(persistentCache);
    console.log("[DEBUG RESULT] primaryDate:", data.primaryDate, "mapSize:", data.episodeDateMap.size);
    console.
