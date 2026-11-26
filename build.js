/**
 * build.js — Static Stremio & Wako catalog + meta generator
 * TMDB discovery & metadata + epguides.frecar.no episode dates + persistent JSON cache
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
const DEBUG_ONLY_SHOW = "";

const auditLogs = [];
const jsonCache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isValidYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const toIsoMidnight = (d) => (isValidYmd(d) ? `${d}T00:00:00.000Z` : undefined);
const normalizeTitle = (s) =>
  (s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function normalizeDateYmd(rawVal) {
  if (!rawVal) return null;
  const s = String(rawVal).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  if (iso) return iso[1];
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

function addDaysYmd(ymdStr, deltaDays) {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

async function fetchJSON(url, timeoutMs = 7000, retries = 1) {
  if (jsonCache.has(url)) return jsonCache.get(url);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (res.status === 404) { jsonCache.set(url, null); return null; }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (!res.ok) { jsonCache.set(url, null); return null; }
      const data = await res.json();
      jsonCache.set(url, data);
      return data;
    } catch {
      if (attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
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
      const i = nextIndex++;
      results[i] = await workerFn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function loadPersistentDateCache() {
  try {
    if (!fs.existsSync(DATE_CACHE_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(DATE_CACHE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savePersistentDateCache(cacheObj) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(DATE_CACHE_FILE, JSON.stringify(cacheObj, null, 2));
}

function isCacheEntryFresh(entry, nowMs = Date.now()) {
  if (!entry || typeof entry.fetchedAt !== "number") return false;
  return (nowMs - entry.fetchedAt) < (entry.miss ? MISS_TTL_MS : CACHE_TTL_MS);
}

function toEpguidesSlugs(title) {
  const raw = (title || "").trim();
  if (!raw) return [];
  const noParens = raw.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const noArt = raw.replace(/^(the|a|an)\s+/i, "").trim();
  const clean = noParens.replace(/^(the|a|an)\s+/i, "").trim();
  const slugs = [];
  for (const v of [raw, noParens, noArt, clean]) {
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
  return [...pool].reverse().find((d) => d <= cutoffDate) || pool[0];
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
    const season = Number(item.season ?? item.season_number ?? item.seasonNumber ?? item.s ?? 0);
    const episode = Number(item.episode ?? item.episode_number ?? item.episodeNumber ?? item.number ?? item.e ?? 0);
    const rawDate = item.airdate ?? item.air_date ?? item.release_date ?? item.releaseDate ?? item.date ?? null;
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
  const latestSeasonDatesAsc =
    highestSeason > 0 && seasonDates.has(highestSeason)
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
  return [...new Set(scored.map((s) => s.slug))].slice(0, 3);
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
      : isValidYmd(cached.primaryDate)
        ? cached.primaryDate
        : pickPrimaryDate(allDates, cutoffDate, latestSeasonDatesAsc);
    if (DEBUG_ONLY_SHOW) console.log(`[CACHE HIT] "${showName}" -> ${primaryDate || "-"} (${episodeDateMap.size} eps)`);
    return { primaryDate, allDates, episodeDateMap, fromCache: true };
  }

  const slugs = toEpguidesSlugs(showName);
  let resolved = null;

  for (const slug of slugs) {
    await sleep(EPGUIDES_DELAY_MS);
    const url = `${EPGUIDES_BASE}/shows/${encodeURIComponent(slug)}/episodes`;
    if (DEBUG_ONLY_SHOW) console.log(`[EPGUIDES TRY] ${url}`);
    const parsed = parseEpisodesPayload(await fetchJSON(url));
    if (parsed.episodeDateMap.size > 0 || parsed.allDates.length > 0) { resolved = parsed; break; }
  }

  if (!resolved) {
    await sleep(EPGUIDES_DELAY_MS);
    const searchUrl = `${EPGUIDES_BASE}/shows/search?query=${encodeURIComponent(showName)}`;
    if (DEBUG_ONLY_SHOW) console.log(`[EPGUIDES SEARCH] ${searchUrl}`);
    const candSlugs = extractSearchSlugs(await fetchJSON(searchUrl), showName);
    for (const candSlug of candSlugs) {
      if (slugs.includes(candSlug)) continue;
      await sleep(EPGUIDES_DELAY_MS);
      const url = `${EPGUIDES_BASE}/shows/${encodeURIComponent(candSlug)}/episodes`;
      if (DEBUG_ONLY_SHOW) console.log(`[EPGUIDES CAND] ${url}`);
      const parsed = parseEpisodesPayload(await fetchJSON(url));
      if (parsed.episodeDateMap.size > 0 || parsed.allDates.length > 0) { resolved = parsed; break; }
    }
  }

  if (!resolved) {
    persistentCache[cacheKey] = {
      showName, miss: true, primaryDate: "", allDates: [], latestSeasonDatesAsc: [], episodes: {}, fetchedAt: Date.now()
    };
    return { primaryDate: "", allDates: [], episodeDateMap: new Map(), fromCache: false };
  }

  const primaryDate = pickPrimaryDate(resolved.allDates, cutoffDate, resolved.latestSeasonDatesAsc);
  const episodesObj = Object.fromEntries(resolved.episodeDateMap.entries());
  persistentCache[cacheKey] = {
    showName, miss: false, primaryDate, allDates: resolved.allDates,
    latestSeasonDatesAsc: resolved.latestSeasonDatesAsc, episodes: episodesObj, fetchedAt: Date.now()
  };

  return { primaryDate, allDates: resolved.allDates, episodeDateMap: resolved.episodeDateMap, fromCache: false };
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
  const ratingObj = ratingsData?.results?.find((r) => r.iso_3166_1 === country) || ratingsData?.results?.[0];
  const kwList = keywordsData?.results || keywordsData?.keywords || [];
  return {
    details,
    certification: ratingObj ? ratingObj.rating : null,
    imdbId: externalIds?.imdb_id || null,
    genres: Array.isArray(details.genres) ? details.genres.map((g) => g?.name).filter(Boolean) : [],
    keywords: Array.isArray(kwList) ? kwList.map((k) => k?.name).filter(Boolean) : [],
    originalLanguage: details.original_language,
    networks: Array.isArray(details.networks) ? details.networks.map((n) => n?.name).filter(Boolean) : [],
    voteAverage: details.vote_average ?? null,
    voteCount: details.vote_count ?? 0
  };
}

async function buildSeriesVideos(tmdbId, stremioId, tmdbDetails, scheduleData) {
  const seasons = Array.isArray(tmdbDetails.seasons)
    ? tmdbDetails.seasons.filter((s) => typeof s.season_number === "number" && s.season_number > 0).sort((a, b) => a.season_number - b.season_number)
    : [];
  const seasonPayloads = await Promise.all(
    seasons.map((s) => fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${s.season_number}?api_key=${TMDB_API_KEY}`))
  );
  const episodeDateMap = scheduleData?.episodeDateMap || new Map();
  const fallbackDate = isValidYmd(scheduleData?.primaryDate) ? scheduleData.primaryDate : "";
  const videos = [];

  for (const seasonData of seasonPayloads) {
    if (!seasonData || !Array.isArray(seasonData.episodes)) continue;
    for (const ep of seasonData.episodes) {
      if (typeof ep.episode_number !== "number") continue;
      const epDate = episodeDateMap.get(`${seasonData.season_number}:${ep.episode_number}`) || fallbackDate;
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
    "qi", "qi xl", "blankety blank", "house shock",
    "home town takeover canada", "saturday night live",
    "the adam ray show", "awkwafina: the unlikely cook"
  ];
  if (whitelistedIds.includes(Number(tmdbId)) || whitelistedTitles.some((t) => name === t || name.includes(t))) {
    return { exclude: false, reason: "Whitelisted Override", whitelisted: true };
  }
  if (tmdbMeta.voteCount === 0 || (tmdbMeta.voteAverage !== null && tmdbMeta.voteAverage < 0.5)) {
    return { exclude: true, reason: `Excluded: Unrated or rating below 5% (Votes: ${tmdbMeta.voteCount})`, whitelisted: false };
  }
  const genres = (tmdbMeta.genres || []).map((g) => String(g || "").toLowerCase());
  const lang = (tmdbMeta.originalLanguage || "").toLowerCase();
  const networks = (tmdbMeta.networks || []).map((n) => String(n || "").toLowerCase());
  const keywords = (tmdbMeta.keywords || []).map((k) => String(k || "").toLowerCase());
  const lowerOverview = (tmdbMeta.details.overview || "").toLowerCase();

  if (lang !== "en") return { exclude: true, reason: `Excluded: Non-English language ('${lang}')`, whitelisted: false };
  if (/[\u4e00-\u9fa5\u3040-\u30ff\u3130-\u318f\u0400-\u04ff]/.test(showName)) {
    return { exclude: true, reason: `Excluded: Contains foreign script (${showName})`, whitelisted: false };
  }
  const blockedNetworks = ["iqiyi", "bilibili", "wavve", "youku", "tencent qq", "vivaone", "premier", "смотрим", "кион", "geo entertainment", "tokyo mx"];
  if (networks.some((net) => blockedNetworks.some((b) => net.includes(b)))) {
    return { exclude: true, reason: `Excluded: Blocked Network (${networks.join(", ")})`, whitelisted: false };
  }
  const wrestlingTerms = ["wwe", "aew", "njpw", "impact wrestling", "ring of honor", "smackdown", "wrestlemania", "royal rumble", "professional wrestling", "pro wrestling"];
  if (wrestlingTerms.some((term) => name.includes(term)) || keywords.some((k) => k.includes("wrestling")) || (lowerOverview.includes("wrestling") && (lowerOverview.includes("ring") || lowerOverview.includes("championship")))) {
    return { exclude: true, reason: `Excluded: Professional Wrestling (${showName})`, whitelisted: false };
  }
  if (name.includes("san pito pato") || name.includes("dragon baby") || name.includes("mayday for my devil") || lowerOverview.includes("vertical drama") || lowerOverview.includes("short drama") || (name.includes("devil") && lowerOverview.includes("billionaire"))) {
    return { exclude: true, reason: "Excluded: Vertical short-drama / micro-series pattern", whitelisted: false };
  }
  const allowedGenres = ["panel", "quiz", "game show", "game-show", "reality", "home improvement", "renovation"];
  if (genres.some((g) => allowedGenres.some((a) => g.includes(a))) || name.includes("zombie") || name.includes("beach")) {
    return { exclude: false, reason: "Allowed Reality/Renovation Content", whitelisted: false };
  }
  if (genres.some((g) => g.includes("sports"))) return { exclude: true, reason: "Excluded: Sports", whitelisted: false };
  if (genres.some((g) => g.includes("news") || g.includes("talk"))) return { exclude: true, reason: "Excluded: News/Talk", whitelisted: false };
  if (genres.some((g) => g === "documentary")) return { exclude: true, reason: "Excluded: Pure Documentary", whitelisted: false };
  return { exclude: false, reason: "Passed general rules", whitelisted: false };
}

function writeMetaFiles(stremioId, metaObj) {
  const payload = JSON.stringify({ meta: metaObj }, null, 2);
  const rawPath = path.join(META_DIR, `${stremioId}.json`);
  const encodedPath = path.join(META_DIR, `${encodeURIComponent(stremioId)}.json`);
  fs.writeFileSync(rawPath, payload);
  if (encodedPath !== rawPath) fs.writeFileSync(encodedPath, payload);
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
    console.log("[DEBUG RESULT] sample map:", [...data.episodeDateMap.entries()].slice(-10));
    return;
  }

  console.log(`Discovering English shows from TMDB (${LOOKAHEAD_DAYS}-day lookahead + ${RETENTION_DAYS_BACK}-day window)...`);
  const targetDates = [];
  for (let offset = -RETENTION_DAYS_BACK; offset <= LOOKAHEAD_DAYS; offset++) {
    targetDates.push(addDaysYmd(todayStr, offset));
  }

  await mapWithConcurrency(targetDates, 6, async (dateStr) => {
    let page = 1;
    let totalPages = 1;
    do {
      const url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API_KEY}&air_date.gte=${dateStr}&air_date.lte=${dateStr}&with_original_language=en&sort_by=popularity.desc&page=${page}`;
      const data = await fetchJSON(url, 6000);
      if (data?.results) {
        totalPages = Math.min(data.total_pages || 1, 10);
        for (const show of data.results) discoveredIds.add(show.id);
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
      tmdbId, showName, audit, imdbId: tmdbMeta.imdbId || null,
      stremioId: `tmdb:${tmdbId}`, tmdbDetails: tmdbMeta.details, tmdbMeta
    });
  });

  console.log(`Fetching epguides dates for ${filteredCandidates.length} kept shows...`);
  let completedSchedule = 0;
  let showsWithDates = 0;
  let cacheHits = 0;

  const activeCandidates = await mapWithConcurrency(filteredCandidates, EPGUIDES_CONCURRENCY, async (item) => {
    const scheduleData = await fetchEpguidesScheduleData(item.showName, todayStr, persistentCache, false);
    if (scheduleData.fromCache) cacheHits++;
    const airDate = isValidYmd(scheduleData.primaryDate) ? scheduleData.primaryDate : "";
    if (airDate) showsWithDates++;
    completedSchedule++;
    if (completedSchedule % 25 === 0 || completedSchedule === filteredCandidates.length) {
      console.log(`epguides progress: ${completedSchedule}/${filteredCandidates.length} (withDates=${showsWithDates}, cacheHits=${cacheHits}, elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    }
    return { ...item, scheduleData, airDate };
  });

  savePersistentDateCache(persistentCache);

  activeCandidates.sort((a, b) => {
    const aHas = isValidYmd(a.airDate);
    const bHas = isValidYmd(b.airDate);
    if (aHas && bHas) return b.airDate.localeCompare(a.airDate);
    if (aHas) return -1;
    if (bHas) return 1;
    return a.showName.localeCompare(b.showName);
  });

  if (!fs.existsSync(CATALOG_DIR)) fs.mkdirSync(CATALOG_DIR, { recursive: true });
  if (!fs.existsSync(META_DIR)) {
    fs.mkdirSync(META_DIR, { recursive: true });
  } else {
    for (const existingFile of fs.readdirSync(META_DIR)) {
      if (existingFile.endsWith(".json")) fs.unlinkSync(path.join(META_DIR, existingFile));
    }
  }

  console.log(`Generating static meta files for ${activeCandidates.length} shows...`);
  const metas = await mapWithConcurrency(activeCandidates, 6, async (item) => {
    auditLogs.push({
      name: item.showName,
      status: "KEPT",
      airDate: item.airDate || "-",
      mappedEpisodes: item.scheduleData?.episodeDateMap?.size || 0,
      detail: item.audit.reason
    });

    const posterDate = item.airDate || undefined;
    const videos = await buildSeriesVideos(item.tmdbId, item.stremioId, item.tmdbDetails, item.scheduleData);

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

  fs.writeFileSync(path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"), JSON.stringify({ metas }, null, 2));

  console.log("\n=================================================================================");
  console.log("            TMDB DAILY DISCOVERY REPORT SUMMARY                                ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
  console.log(`Successfully generated ${metas.length} shows (${showsWithDates} with air dates, ${cacheHits} from cache) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}

build().catch((err) => { console.error(err); process.exit(1); });
