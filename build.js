/**
 * build.js — Stremio & Wako compatible static catalog + meta generator
 * TMDB Daily Discover + Next-Episode.net dates
 * All dates come strictly from next-episode.net (zero TMDB air_date usage).
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
const NEXT_EPISODE_CONCURRENCY = 3;
const NEXT_EPISODE_DELAY_MS = 200;

//Set to a show name (e.g. "Stick") to debug a single show, or "" for full run
const DEBUG_ONLY_SHOW = "12 12 12";

const auditLogs = [];
const htmlCache = new Map();

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

async function fetchJSON(url, timeoutMs = 7000) {
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

async function fetchNextEpisodeHTML(url, timeoutMs = 6000, retries = 1) {
  if (htmlCache.has(url)) {
    return htmlCache.get(url);
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://next-episode.net/"
        }
      });

      if (res.status === 404) {
        htmlCache.set(url, null);
        return null;
      }

      const text = await res.text();
      if (DEBUG_ONLY_SHOW) {
        console.log(`[FETCH] ${url} -> status=${res.status} bytes=${text.length}`);
      }

      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        await sleep(800 * (attempt + 1));
        continue;
      }

      const result = res.ok ? text : null;
      htmlCache.set(url, result);
      return result;
    } catch (err) {
      if (DEBUG_ONLY_SHOW) {
        console.log(`[FETCH ERR] ${url} -> ${err?.message || String(err)}`);
      }
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      htmlCache.set(url, null);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  htmlCache.set(url, null);
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

function normalizeTitleTokens(str) {
  return (str || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function toNextEpisodeSlugs(title) {
  const raw = (title || "").toLowerCase().trim();
  if (!raw) return [];

  const variants = [
    raw,
    raw.replace(/\s*\([^)]*\)\s*/g, " "),
    raw.replace(/^(the|a|an)\s+/i, ""),
    raw.replace(/\s*\([^)]*\)\s*/g, " ").replace(/^(the|a|an)\s+/i, "")
  ];

  const slugs = [];
  for (const v of variants) {
    const cleaned = v
      .replace(/['’]/g, "")
      .replace(/&/g, "and")
      .trim();
    const dashed = cleaned.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const compact = cleaned.replace(/[^a-z0-9]+/g, "");
    if (dashed) slugs.push(dashed);
    if (compact) slugs.push(compact);
  }

  return [...new Set(slugs)];
}

function parseNextEpisodeDateText(rawDateText) {
  if (!rawDateText) return null;
  const match = rawDateText.match(/\b(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\b/);
  if (!match) return null;

  const monthNum = MONTHS[match[1].toLowerCase()];
  if (!monthNum) return null;

  const day = match[2].padStart(2, "0");
  const year = match[3];
  const ymd = `${year}-${monthNum}-${day}`;
  return isValidYmd(ymd) ? ymd : null;
}

function stripTags(str) {
  return str
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#?\w+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreCandidateMatch(showName, candidateSlug, anchorText = "") {
  const showTokens = normalizeTitleTokens(showName);
  if (showTokens.length === 0) return 0;

  const combinedTokens = new Set([
    ...normalizeTitleTokens(candidateSlug.replace(/-/g, " ")),
    ...normalizeTitleTokens(anchorText)
  ]);

  let hits = 0;
  for (const tok of showTokens) {
    if (combinedTokens.has(tok)) hits++;
  }

  const exactSlugMatch = toNextEpisodeSlugs(showName).includes(candidateSlug.toLowerCase()) ? 2 : 0;
  return hits / showTokens.length + exactSlugMatch;
}

function isRealShowPage(html, info) {
  if (!html) return false;
  if (info.allDates.length > 0 || info.seasonNumbers.length > 0) return true;
  return /\bEpisodes\s+Guide\b/i.test(html) || /\bAir\s+Date\b/i.test(html);
}

/**
 * Parses a /<slug>/season-<N> page into { seasonNumber, episodes: Map<episodeNum, ymd> }
 */
function parseSeasonTableHtml(html, fallbackSeasonNumber = 1) {
  const result = new Map();
  const seasonNumber = Number(fallbackSeasonNumber) > 0 ? Number(fallbackSeasonNumber) : 1;
  if (!html) return { seasonNumber, episodes: result };

  const trMatches = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const tr of trMatches) {
    const rowHtml = tr[1];
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => stripTags(c[1]));
    if (cells.length < 2) continue;

    const epNum = Number(cells[0].match(/^\d{1,3}$/)?.[0] || "");
    if (epNum <= 0) continue;

    for (let c = cells.length - 1; c >= 1; c--) {
      const airDateYmd = parseNextEpisodeDateText(cells[c]);
      if (isValidYmd(airDateYmd)) {
        result.set(epNum, airDateYmd);
        break;
      }
    }
  }

  return { seasonNumber, episodes: result };
}

function parseShowPageInfo(html) {
  if (!html) return { allDates: [], seasonNumbers: [] };

  const plainText = stripTags(html);
  const dateMatches = [
    ...plainText.matchAll(/\b(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\b/g)
  ];

  const allDates = [
    ...new Set(
      dateMatches
        .map(m => parseNextEpisodeDateText(m[0]))
        .filter(isValidYmd)
    )
  ].sort((a, b) => a.localeCompare(b));

  const seasonLinks = [...html.matchAll(/\/season-(\d{1,2})\b/gi)].map(m => Number(m[1]));
  const seasonNumbers = [...new Set(seasonLinks)].filter(n => n > 0).sort((a, b) => a - b);

  return { allDates, seasonNumbers };
}

/**
 * Picks the most recent date <= cutoffDate (or earliest upcoming date if all are in the future).
 * When season dates are available, prefers dates from the highest season scraped so old seasons
 * on long-running shows don't override current dates.
 */
function pickPrimaryDate(datesAsc, cutoffDate, latestSeasonDatesAsc = []) {
  const pool = latestSeasonDatesAsc.length > 0 ? latestSeasonDatesAsc : datesAsc;
  if (!Array.isArray(pool) || pool.length === 0) return "";
  const pastOrToday = [...pool].reverse().find(d => d <= cutoffDate);
  if (pastOrToday) return pastOrToday;
  return pool[0];
}

async function getNextEpisodeScheduleData(showName, cutoffDate, maxSeasonHint = 1) {
  const slugs = toNextEpisodeSlugs(showName);
  const episodeDateMap = new Map();
  let allDates = [];
  let latestSeasonDatesAsc = [];

  let matchedSlug = "";
  let discoveredSeasons = [];

  for (const slug of slugs) {
    await sleep(NEXT_EPISODE_DELAY_MS);
    const showHtml = await fetchNextEpisodeHTML(`https://next-episode.net/${slug}`);
    if (!showHtml) continue;

    const info = parseShowPageInfo(showHtml);
    if (isRealShowPage(showHtml, info)) {
      matchedSlug = slug;
      allDates = [...info.allDates];
      discoveredSeasons = info.seasonNumbers;
      break;
    }
  }

  if (!matchedSlug) {
    const ignoredPaths = new Set([
      "browse", "calendar", "login", "register", "search", "news",
      "trailers", "top", "popular", "recent", "privacy", "terms", "contact", "faq", "premium", "shows"
    ]);

    await sleep(NEXT_EPISODE_DELAY_MS);
    const searchUrl = `https://next-episode.net/search/?name=${encodeURIComponent(showName)}`;
    const searchHtml = await fetchNextEpisodeHTML(searchUrl);
    if (searchHtml) {
      const scoredCandidates = [];
      for (const aMatch of searchHtml.matchAll(/<a[^>]+href=["']\/([a-z0-9-]+)(?:\/[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const candidateSlug = aMatch[1].toLowerCase();
        if (ignoredPaths.has(candidateSlug) || candidateSlug.startsWith("season-")) continue;
        const anchorText = stripTags(aMatch[2]);
        const score = scoreCandidateMatch(showName, candidateSlug, anchorText);
        if (score > 0) {
          scoredCandidates.push({ slug: candidateSlug, score });
        }
      }

      scoredCandidates.sort((a, b) => b.score - a.score);
      const uniqueCandidates = [...new Map(scoredCandidates.map(c => [c.slug, c])).values()].slice(0, 2);

      for (const cand of uniqueCandidates) {
        await sleep(NEXT_EPISODE_DELAY_MS);
        const candidateHtml = await fetchNextEpisodeHTML(`https://next-episode.net/${cand.slug}`);
        if (!candidateHtml) continue;
        const info = parseShowPageInfo(candidateHtml);
        if (isRealShowPage(candidateHtml, info)) {
          matchedSlug = cand.slug;
          allDates = [...info.allDates];
          discoveredSeasons = info.seasonNumbers;
          break;
        }
      }
    }
  }

  if (matchedSlug) {
    const hasExplicitLinks = discoveredSeasons.length > 0;
    const highestSeason = Math.max(
      maxSeasonHint || 1,
      hasExplicitLinks ? Math.max(...discoveredSeasons) : 1
    );
    const seasonsToFetch = hasExplicitLinks
      ? discoveredSeasons
      : Array.from({ length: Math.min(highestSeason, 30) }, (_, idx) => idx + 1);

    const seasonDatesSet = new Set();
    let consecutiveEmptyAfterSeason1 = 0;

    for (const sNum of seasonsToFetch) {
      await sleep(NEXT_EPISODE_DELAY_MS);
      const seasonHtml = await fetchNextEpisodeHTML(`https://next-episode.net/${matchedSlug}/season-${sNum}`);
      const parsedSeason = parseSeasonTableHtml(seasonHtml, sNum);

      if (parsedSeason.episodes.size === 0) {
        if (!hasExplicitLinks && sNum > 1) {
          consecutiveEmptyAfterSeason1++;
          if (consecutiveEmptyAfterSeason1 >= 2) break;
        }
        continue;
      }

      consecutiveEmptyAfterSeason1 = 0;
      const currentSeasonDates = new Set();
      for (const [epNum, ymd] of parsedSeason.episodes.entries()) {
        episodeDateMap.set(`${parsedSeason.seasonNumber}:${epNum}`, ymd);
        seasonDatesSet.add(ymd);
        currentSeasonDates.add(ymd);
      }
      if (currentSeasonDates.size > 0) {
        latestSeasonDatesAsc = [...currentSeasonDates].sort((a, b) => a.localeCompare(b));
      }
    }

    if (seasonDatesSet.size > 0) {
      allDates = [...seasonDatesSet].sort((a, b) => a.localeCompare(b));
    } else {
      allDates = [...new Set(allDates)].sort((a, b) => a.localeCompare(b));
    }
  }

  const primaryDate = pickPrimaryDate(allDates, cutoffDate, latestSeasonDatesAsc);
  return { primaryDate, allDates, episodeDateMap };
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
 * Builds Stremio videos using next-episode.net episodeDateMap.
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
  const fallbackDate = isValidYmd(nextEpisodeData?.primaryDate) ? nextEpisodeData.primaryDate : "";

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

  if (DEBUG_ONLY_SHOW) {
    const searchJson = await fetchJSON(
      `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(DEBUG_ONLY_SHOW)}`
    );
    const firstId = searchJson?.results?.[0]?.id;
    console.log(`[DEBUG MODE] Show="${DEBUG_ONLY_SHOW}" -> TMDB id=${firstId}`);
    if (firstId) {
      const meta = await getTmdbMetadata(firstId);
      const maxSeasonHint = Array.isArray(meta?.details?.seasons)
        ? Math.max(1, ...meta.details.seasons.map(s => Number(s.season_number) || 0))
        : 1;
      const neData = await getNextEpisodeScheduleData(meta.details.name, todayStr, maxSeasonHint);
      console.log("[DEBUG RESULT] primaryDate:", neData.primaryDate, "mapSize:", neData.episodeDateMap.size);
      console.log("[DEBUG RESULT] sample map:", [...neData.episodeDateMap.entries()].slice(-10));
    }
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

    const maxSeasonHint = Array.isArray(tmdbMeta.details.seasons)
      ? Math.max(1, ...tmdbMeta.details.seasons.map(s => Number(s.season_number) || 0))
      : 1;

    filteredCandidates.push({
      tmdbId,
      showName,
      audit,
      maxSeasonHint,
      imdbId: tmdbMeta.imdbId || null,
      stremioId: `tmdb:${tmdbId}`,
      tmdbDetails: tmdbMeta.details,
      tmdbMeta
    });
  });

  console.log(`Fetching Next Episode dates for ${filteredCandidates.length} kept shows...`);
  let completedNextEpisode = 0;
  let showsWithDates = 0;

  const activeCandidates = await mapWithConcurrency(filteredCandidates, NEXT_EPISODE_CONCURRENCY, async (item) => {
    const nextEpisodeData = await getNextEpisodeScheduleData(item.showName, todayStr, item.maxSeasonHint);
    const nextEpisodeDate = isValidYmd(nextEpisodeData.primaryDate) ? nextEpisodeData.primaryDate : "";
    if (nextEpisodeDate) showsWithDates++;
    completedNextEpisode++;
    if (completedNextEpisode % 25 === 0 || completedNextEpisode === filteredCandidates.length) {
      console.log(
        `Next Episode progress: ${completedNextEpisode}/${filteredCandidates.length} (withDates=${showsWithDates}, elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
      );
    }
    return {
      ...item,
      nextEpisodeData,
      nextEpisodeDate
    };
  });

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
      mappedEpisodes: item.nextEpisodeData?.episodeDateMap?.size || 0,
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
  console.log(`Successfully generated ${metas.length} shows (${showsWithDates} with next-episode dates) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}

build().catch(err => { console.error(err); process.exit(1); });
