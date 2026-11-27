/**
 * build.js — Static Stremio & Wako series catalog generator
 * Discovers English shows on TMDB + uses TVMaze for posters, episode air dates & genre check
 * No meta file generation
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = process.env.TMDB_API_KEY;

if (!TMDB_API_KEY || TMDB_API_KEY.trim() === "") {
  console.error("\nERROR: TMDB_API_KEY environment variable is not defined or is empty.\n");
  process.exit(1);
}

const CATALOG_DIR = path.join(__dirname, "catalog", "series");
const META_DIR = path.join(__dirname, "meta", "series");
const TVMAZE_BASE = "https://api.tvmaze.com";

const LOOKAHEAD_DAYS = 3;
const RETENTION_DAYS_BACK = 9;
const TVMAZE_CONCURRENCY = 4;
const TVMAZE_DELAY_MS = 120;

const jsonCache = new Map();
const auditLogs = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isValidYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const normalizeTitle = (s) =>
  (s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const map = {};
  parts.forEach((p) => {
    map[p.type] = p.value;
  });
  return `${map.year}-${map.month}-${map.day}`;
}

function addDaysYmd(ymdStr, deltaDays) {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate()
  ).padStart(2, "0")}`;
}

async function fetchJSON(url, timeoutMs = 8000, retries = 1) {
  if (jsonCache.has(url)) return jsonCache.get(url);
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
      const i = nextIndex++;
      results[i] = await workerFn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

async function getTmdbShow(tmdbId) {
  const [details, externalIds] = await Promise.all([
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`),
    fetchJSON(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`)
  ]);
  if (!details) return null;
  return {
    details,
    imdbId: externalIds?.imdb_id || null,
    genres: Array.isArray(details.genres)
      ? details.genres.map((g) => g?.name).filter(Boolean)
      : [],
    originalLanguage: details.original_language,
    networks: Array.isArray(details.networks)
      ? details.networks.map((n) => n?.name).filter(Boolean)
      : [],
    voteAverage: details.vote_average ?? null,
    voteCount: details.vote_count ?? 0
  };
}

function evaluateExclusion(tmdbId, showName, tmdbShow) {
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
    whitelistedTitles.some((t) => name === t || name.includes(t))
  ) {
    return { exclude: false, reason: "Whitelisted Override" };
  }
  if (tmdbShow.voteCount === 0 || (tmdbShow.voteAverage !== null && tmdbShow.voteAverage < 0.5)) {
    return {
      exclude: true,
      reason: `Excluded: Unrated or rating below 5% (Votes: ${tmdbShow.voteCount})`
    };
  }
  const genres = (tmdbShow.genres || []).map((g) => String(g || "").toLowerCase());
  const lang = (tmdbShow.originalLanguage || "").toLowerCase();
  const networks = (tmdbShow.networks || []).map((n) => String(n || "").toLowerCase());
  const lowerOverview = (tmdbShow.details.overview || "").toLowerCase();

  if (lang !== "en") {
    return { exclude: true, reason: `Excluded: Non-English language ('${lang}')` };
  }
  if (/[\u4e00-\u9fa5\u3040-\u30ff\u3130-\u318f\u0400-\u04ff]/.test(showName)) {
    return { exclude: true, reason: `Excluded: Contains foreign script (${showName})` };
  }

  const blockedNetworks = [
    "iqiyi",
    "bilibili",
    "wavve",
    "youku",
    "tencent qq",
    "vivaone",
    "premier",
    "смотрим",
    "кион",
    "geo entertainment",
    "tokyo mx"
  ];
  if (networks.some((net) => blockedNetworks.some((b) => net.includes(b)))) {
    return { exclude: true, reason: `Excluded: Blocked Network (${networks.join(", ")})` };
  }

  const wrestlingTitlePatterns = [
    /\bwwe\b/i,
    /\baew\b/i,
    /\bnjpw\b/i,
    /\btna\b/i,
    /\bmlw\b/i,
    /\bncw\b/i,
    /\bovw\b/i,
    /\bczw\b/i,
    /\bgcw\b/i,
    /\bpro[- ]?wrestling\b/i,
    /\bprofessional wrestling\b/i,
    /\bwrestling\b/i,
    /\bsmackdown\b/i,
    /\bmonday night raw\b/i,
    /\bwrestlemania\b/i,
    /\broyal rumble\b/i,
    /\bsummerslam\b/i,
    /\bsurvivor series\b/i,
    /\baew (dynamite|collision|rampage|dark)\b/i,
    /\bwwe (nxt|raw|speed|evolve|main event|superstars|level up|lfg)\b/i,
    /\bimpact!? wrestling\b/i,
    /\bring of honor\b/i,
    /\bnew japan pro\b/i,
    /\ball elite\b/i,
    /\bchampionship wrestling\b/i,
    /\bworld wrestling\b/i,
    /\bwrestler(s)?\b/i
  ];
  const wrestlingOverviewTerms = [
    "professional wrestling",
    "pro wrestling",
    "pro-wrestling",
    "wwe",
    "all elite wrestling",
    "aew",
    "new japan pro-wrestling",
    "tna wrestling",
    "ring of honor",
    "wrestlers",
    "wrestling promotion",
    "in-ring action",
    "squared circle"
  ];
  if (
    wrestlingTitlePatterns.some((rx) => rx.test(showName)) ||
    wrestlingOverviewTerms.some((term) => lowerOverview.includes(term)) ||
    (lowerOverview.includes("wrestling") &&
      (lowerOverview.includes("ring") ||
        lowerOverview.includes("championship") ||
        lowerOverview.includes("superstars") ||
        lowerOverview.includes("matches")))
  ) {
    return { exclude: true, reason: `Excluded: Professional Wrestling (${showName})` };
  }

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

  const allowedGenres = [
    "panel",
    "quiz",
    "game show",
    "game-show",
    "reality",
    "home improvement",
    "renovation"
  ];
  if (
    genres.some((g) => allowedGenres.some((a) => g.includes(a))) ||
    name.includes("zombie") ||
    name.includes("beach")
  ) {
    return { exclude: false, reason: "Allowed Reality/Renovation Content" };
  }

  if (genres.some((g) => g.includes("sports"))) return { exclude: true, reason: "Excluded: Sports" };
  if (genres.some((g) => g.includes("news") || g.includes("talk"))) {
    return { exclude: true, reason: "Excluded: News/Talk" };
  }
  if (genres.some((g) => g === "documentary")) {
    return { exclude: true, reason: "Excluded: Pure Documentary" };
  }
  return { exclude: false, reason: "Passed general rules" };
}

async function findTvMazeShow(showName, imdbId) {
  if (imdbId) {
    await sleep(TVMAZE_DELAY_MS);
    const byImdb = await fetchJSON(
      `${TVMAZE_BASE}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`
    );
    if (byImdb && byImdb.id) return byImdb;
  }

  await sleep(TVMAZE_DELAY_MS);
  const results = await fetchJSON(
    `${TVMAZE_BASE}/search/shows?q=${encodeURIComponent(showName)}`
  );
  if (!Array.isArray(results) || results.length === 0) return null;

  const targetNorm = normalizeTitle(showName);
  const exact = results.find((r) => normalizeTitle(r?.show?.name) === targetNorm);
  return exact?.show || results[0]?.show || null;
}

function pickLatestEpisodeDate(episodes, cutoffDate) {
  if (!Array.isArray(episodes) || episodes.length === 0) return "";
  const validDates = episodes
    .map((ep) => (isValidYmd(ep?.airdate) ? ep.airdate : null))
    .filter(Boolean)
    .sort
