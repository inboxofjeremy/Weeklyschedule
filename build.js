/**
 * build.js — Static Stremio & Wako series catalog generator
 * Discovers English shows on TMDB + uses TVMaze for posters & episode air dates
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

  const wrestlingTerms = [
    "wwe",
    "aew",
    "njpw",
    "impact wrestling",
    "ring of honor",
    "smackdown",
    "wrestlemania",
    "royal rumble",
    "professional wrestling",
    "pro wrestling"
  ];
  if (
    wrestlingTerms.some((term) => name.includes(term)) ||
    (lowerOverview.includes("wrestling") &&
      (lowerOverview.includes("ring") || lowerOverview.includes("championship")))
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
    .sort((a, b) => a.localeCompare(b));

  if (validDates.length === 0) return "";
  return [...validDates].reverse().find((d) => d <= cutoffDate) || validDates[validDates.length - 1];
}

async function getTvMazeData(showName, imdbId, cutoffDate) {
  const show = await findTvMazeShow(showName, imdbId);
  if (!show) {
    return { matched: false, poster: null, airDate: "", episodeCount: 0 };
  }

  await sleep(TVMAZE_DELAY_MS);
  const episodes = await fetchJSON(`${TVMAZE_BASE}/shows/${show.id}/episodes`);
  const epList = Array.isArray(episodes) ? episodes : [];

  const poster = show.image?.original || show.image?.medium || null;
  const airDate = pickLatestEpisodeDate(epList, cutoffDate);

  return { matched: true, poster, airDate, episodeCount: epList.length };
}

function removeMetaDirIfPresent() {
  if (fs.existsSync(META_DIR)) {
    fs.rmSync(META_DIR, { recursive: true, force: true });
    console.log(`Removed legacy meta directory: ${META_DIR}`);
  }
}

async function build() {
  const startedAt = Date.now();
  const discoveredIds = new Set();
  const todayStr = pacificDateString();

  console.log(`Starting catalog build for reference date (America/Los_Angeles): ${todayStr}`);
  removeMetaDirIfPresent();

  console.log(
    `Discovering English shows from TMDB (${RETENTION_DAYS_BACK} days back to +${LOOKAHEAD_DAYS} days)...`
  );
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
  console.log(
    `Discovered ${candidates.length} candidate shows in ${((Date.now() - startedAt) / 1000).toFixed(1)}s. Evaluating TMDB metadata...`
  );

  const filteredCandidates = [];
  await mapWithConcurrency(candidates, 6, async (tmdbId, idx) => {
    if ((idx + 1) % 50 === 0 || idx + 1 === candidates.length) {
      console.log(
        `TMDB metadata progress: ${idx + 1}/${candidates.length} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
      );
    }
    const tmdbShow = await getTmdbShow(tmdbId);
    if (!tmdbShow) return;
    const showName = tmdbShow.details.name;
    const audit = evaluateExclusion(tmdbId, showName, tmdbShow);
    if (audit.exclude) {
      auditLogs.push({ name: showName, status: "DROPPED", airDate: "-", detail: audit.reason });
      return;
    }

    filteredCandidates.push({
      tmdbId,
      showName,
      audit,
      imdbId: tmdbShow.imdbId || null,
      stremioId: `tmdb:${tmdbId}`,
      details: tmdbShow.details,
      genres: tmdbShow.genres
    });
  });

  console.log(`Fetching TVMaze posters & episode dates for ${filteredCandidates.length} kept shows...`);
  let completedMaze = 0;
  let matchedMaze = 0;
  let withDates = 0;

  const entries = await mapWithConcurrency(filteredCandidates, TVMAZE_CONCURRENCY, async (item) => {
    const tvmaze = await getTvMazeData(item.showName, item.imdbId, todayStr);
    if (tvmaze.matched) matchedMaze++;
    const airDate = isValidYmd(tvmaze.airDate) ? tvmaze.airDate : "";
    if (airDate) withDates++;
    completedMaze++;

    if (completedMaze % 25 === 0 || completedMaze === filteredCandidates.length) {
      console.log(
        `TVMaze progress: ${completedMaze}/${filteredCandidates.length} (matched=${matchedMaze}, withDates=${withDates}, elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
      );
    }

    auditLogs.push({
      name: item.showName,
      status: "KEPT",
      airDate: airDate || "-",
      poster: tvmaze.poster ? "yes" : "no",
      episodes: tvmaze.episodeCount,
      detail: item.audit.reason
    });

    return {
      ...item,
      poster: tvmaze.poster,
      airDate
    };
  });

  entries.sort((a, b) => {
    const aHas = isValidYmd(a.airDate);
    const bHas = isValidYmd(b.airDate);
    if (aHas && bHas) return b.airDate.localeCompare(a.airDate);
    if (aHas) return -1;
    if (bHas) return 1;
    return a.showName.localeCompare(b.showName);
  });

  if (!fs.existsSync(CATALOG_DIR)) {
    fs.mkdirSync(CATALOG_DIR, { recursive: true });
  }

  const metas = entries.map((item) => ({
    id: item.stremioId,
    imdb_id: item.imdbId || undefined,
    tmdb_id: item.tmdbId,
    type: "series",
    name: item.showName,
    genres: item.genres,
    releaseInfo: item.airDate || undefined,
    description: item.details.overview || "",
    poster: item.poster,
    background: item.details.backdrop_path
      ? `https://image.tmdb.org/t/p/original${item.details.backdrop_path}`
      : null
  }));

  const outFile = path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json");
  fs.writeFileSync(outFile, JSON.stringify({ metas }, null, 2));

  console.log("\n=================================================================================");
  console.log("            TVMAZE CATALOG BUILD SUMMARY                                         ");
  console.log("=================================================================================");
  console.table(auditLogs);
  console.log("=================================================================================\n");
  console.log(
    `Wrote ${metas.length} shows to ${outFile} (TVMaze matched=${matchedMaze}, withDates=${withDates}) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`
  );
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
