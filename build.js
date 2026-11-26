/**
 * build.js — Stremio & Wako compatible static catalog + meta generator
 * TMDB Daily Discover + Next-Episode.net dates
 * Generalized next-episode.net scraper for any show; zero TMDB air_date usage.
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

/**
 * Parses a /<slug>/season-<N> page into { seasonNumber, episodes: Map<episodeNum, ymd> }
 */
function parseSeasonTableHtml(html, fallbackSeasonNumber = 0) {
  const result = new Map();
  if (!html) return { seasonNumber: fallbackSeasonNumber, episodes: result };

  const headingMatch = html.match(/\bSeason\s+(\d{1,2})\b/i);
  const seasonNumber = headingMatch ? Number(headingMatch[1]) : fallbackSeasonNumber;

  // 1. Parse table rows where column 1 is episode number and last column (or any cell) has a date
  const trMatches = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const tr of trMatches) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => stripTags(c[1]));
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

  // 2. Fallback for non-table episode blocks on season/show pages
  if (result.size === 0) {
    const plainText = stripTags(html);
    const epRegex = /\b(?:Episode\s*#?\s*(\d{1,3})|S\d{1,2}\s*E(\d{1,3})|\d{1,2}x(\d{1,3}))\b[\s\S]{0,180}?((?:[A-Za-z]{3}\s+)?[A-Za-z]{3}\s+\d{1,2},\s+\d{4})/gi;
    for (const m of plainText.matchAll(epRegex)) {
      const epNum = Number(m[1] || m[2] || m[3]);
      const ymd = parseNextEpisodeDateText(m[4]);
      if (epNum > 0 && isValidYmd(ymd) && !result.has(epNum)) {
        result.set(epNum, ymd);
      }
    }
  }

  return { seasonNumber, episodes: result };
}

/**
 * Parses show-level pages for dates and links to /<slug>/season-<N>.
 */
function parseShowPageDates(html, cutoffDate) {
  if (!html) return { primaryDate: "", allDates: [], seasonNumbers: [] };

  const plainText = stripTags(html);
  const dateMatches = [
    ...plainText.matchAll(/\b(?:Date|Air Date)\s*:?\s*((?:[A-Za-z]{3}\s+)?[A-Za-z]{3}\s+\d{1,2},\s+\d{4})\b/gi)
  ];

  const allDates = [
    ...new Set(
      dateMatches
        .map(m => parseNextEpisodeDateText(m[1]))
        .filter(isValidYmd)
    )
  ].sort((a, b) => b.localeCompare(a));

  const seasonLinks = [...html.matchAll(/\/season-(\d{1,2})\b/gi)].map(m => Number(m[1]));
  const seasonNumbers = [...new Set(seasonLinks)].filter(n => n > 0).sort((a, b) => a - b);

  if (allDates.length === 0) {
    return { primaryDate: "", allDates: [], seasonNumbers };
  }

  const pastOrToday = allDates.find(d => d <= cutoffDate);
  if (pastOrToday) {
    return { primaryDate: pastOrToday, allDates, seasonNumbers };
  }

  const upcomingSorted = [...allDates].sort((a, b) => a.localeCompare(b));
  return { primaryDate: upcomingSorted[0], allDates, seasonNumbers };
}

async function getNextEpisodeScheduleData(showName, cutoffDate, maxSeasonHint = 1) {
  const slugs = toNextEpisodeSlugs(showName);
  const episodeDateMap = new Map();
  let primaryDate = "";
  let allDates = [];

  let matchedSlug = "";
  let discoveredSeasons = [];

  for (const slug of slugs) {
    await sleep(NEXT_EPISODE_DELAY_MS);
    const showHtml = await fetchNextEpisodeHTML(`https://next-episode.net/${slug}`);
    if (!showHtml) continue;

    const info = parseShowPageDates(showHtml, cutoffDate);
    if (info.primaryDate || info.seasonNumbers.length > 0 || /\bEpisodes\b/i.test(showHtml)) {
      matchedSlug = slug;
      primaryDate = info.primaryDate;
      allDates = info.allDates;
      discoveredSeasons = info.seasonNumbers;
      break;
    }
  }

  if (!matchedSlug) {
    const ignoredPaths = new Set([
      "browse", "calendar", "login", "register", "search", "news",
      "trailers", "top", "popular", "recent", "privacy", "terms", "contact", "faq", "premium", "shows"
    ]);

    const searchQueries = [
      `https://next-episode.net/search/?name=${encodeURIComponent(showName)}`,
      `https://next-episode.net/search/?q=${encodeURIComponent(showName)}`
    ];

    const scoredCandidates = [];
    for (const sUrl of searchQueries) {
      await sleep(NEXT_EPISODE_DELAY_MS);
      const searchHtml = await fetchNextEpisodeHTML(sUrl);
      if (!searchHtml) continue;

      for (const aMatch of searchHtml.matchAll(/<a[^>]+href=["']\/([a-z0-9-]+)(?:\/[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const candidateSlug = aMatch[1].toLowerCase();
        if (ignoredPaths.has(candidateSlug) || candidateSlug.startsWith("season-")) continue;
        const anchorText = stripTags(aMatch[2]);
        const score = scoreCandidateMatch(showName, candidateSlug, anchorText);
        if (score > 0) {
          scoredCandidates.push({ slug: candidateSlug, score });
        }
      }
      if (scoredCandidates.length > 0) break;
    }

    scoredCandidates.sort((a, b) => b.score - a.score);
    const uniqueCandidates = [...new Map(scoredCandidates.map(c => [c.slug, c])).values()].slice(0, 3);

    for (const cand of uniqueCandidates) {
      await sleep(NEXT_EPISODE_DELAY_MS);
      const candidateHtml = await fetchNextEpisodeHTML(`https://next-episode.net/${cand.slug}`);
      if (!candidateHtml) continue;
      const info = parseShowPageDates(candidateHtml, cutoffDate);
      if (info.primaryDate || info.seasonNumbers.length > 0 || /\bEpisodes\b/i.test(candidateHtml)) {
        matchedSlug = cand.slug;
        primaryDate = info.primaryDate;
        allDates = info.allDates;
        discoveredSeasons = info.seasonNumbers;
        break;
      }
    }
  }

  if (matchedSlug) {
    const highestSeason = Math.max(
      maxSeasonHint || 1,
      discoveredSeasons.length > 0 ? Math.max(...discoveredSeasons) : 1
    );
    const seasonsToFetch =
      discoveredSeasons.length > 0
        ? discoveredSeasons
        : Array.from({ length: Math.min(highestSeason, 25) }, (_, idx) => idx + 1);

    for (const sNum of seasonsToFetch) {
      await sleep(NEXT_EPISODE_DELAY_MS);
      const seasonHtml = await fetchNextEpisodeHTML(`https://next-episode.net/${matchedSlug}/season-${sNum}`);
      const parsedSeason = parseSeasonTableHtml(seasonHtml, sNum);
      for (const [epNum, ymd] of parsedSeason.episodes.entries()) {
        episodeDateMap.set(`${parsedSeason.seasonNumber}:${epNum}`, ymd);
        allDates.push(ymd);
      }
    }
  }

  allDates = [...new Set(allDates)].sort((a, b) => b.localeCompare(a));
  if (!primaryDate && allDates.length > 0) {
    const pastOrToday = allDates.find(d => d <= cutoffDate);
    if (pastOrToday) {
      primaryDate = pastOrToday;
    } else {
      const upcomingSorted = [...allDates].sort((a, b) => a.localeCompare(b));
      primaryDate = upcomingSorted[0];
    }
  }

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
 * Builds Stremio videos so every episode has a next-episode.net date (zero TMDB air_date usage).
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
  const anchorDate =
    (isValidYmd(nextEpisodeData?.primaryDate) && nextEpisodeData.primaryDate) ||
    (Array.isArray(nextEpisodeData?.allDates) && nextEpisodeData.allDates.find(isValidYmd)) ||
    "";

  const videos = [];
  for (const seasonData of seasonPayloads) {
    if (!seasonData || !Array.isArray(seasonData.episodes)) continue;
    for (const ep of seasonData.episodes) {
      if (typeof ep.episode_number !== "number") continue;
      const key = `${seasonData.season_number}:${ep.episode_number}`;
      const epDate = episodeDateMap.get(key) || anchorDate;
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
  const activeCandidates = [];
  for (let i = 0; i < filteredCandidates.length; i++) {
    const item = filteredCandidates[i];
    if ((i + 1) % 25 === 0 || i + 1 === filteredCandidates.length) {
      console.log(`Next Episode progress: ${i + 1}/${filteredCandidates.length} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    }
    const nextEpisodeData = await getNextEpisodeScheduleData(item.showName, todayStr, item.maxSeasonHint);
    const nextEpisodeDate = isValidYmd(nextEpisodeData.primaryDate) ? nextEpisodeData.primaryDate : "";
    activeCandidates.push({
      ...item,
      nextEpisodeData,
      nextEpisodeDate
    });
  }

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
