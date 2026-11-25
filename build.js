/**
 * build.js — Stremio & Wako compatible static adult catalog
 * TMDB Daily Discover (3-Day Lookahead + 9-Day Rolling Window) + Rate-Limit-Safe Live Stream Verification
 * Extracts stream availability dates from stream payloads when present, falling back to persisted
 * stream availability state or todayStr, and clamps sortDate only when verified and different from listedDate.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMDB_API_KEY = process.env.TMDB_API_KEY;

function normalizeStreamAddonBaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  return rawUrl
    .trim()
    .split("?")[0]
    .split("#")[0]
    .replace(/\/manifest\.json\/?$/i, "")
    .replace(/\/+$/, "");
}

// Base URL of your Stremio stream addon WITHOUT query string, trailing slash, or /manifest.json
// Example: https://aiostreams.example.com/stremio/your-config-id
const STREAM_ADDON_URL = normalizeStreamAddonBaseUrl(process.env.STREAM_ADDON_URL || "");

if (!TMDB_API_KEY || TMDB_API_KEY.trim() === "") {
  console.error("\n❌ ERROR: TMDB_API_KEY environment variable is not defined or is empty!\n");
  process.exit(1);
}

const CATALOG_DIR = path.join(__dirname, "catalog", "series");
const STREAM_STATE_FILE = path.join(__dirname, "catalog", "stream-availability.json");
const LOOKAHEAD_DAYS = 3; // Catch streaming episodes dropping up to 3 days before TMDB's official date
const RETENTION_DAYS_BACK = 9; // 9-day rolling window
const RECENT_FALLBACK_DAYS = 3; // Probe lastEp and lastEp + 1 for recent/today episodes or whitelisted shows
const STREAM_CONCURRENCY = Number(process.env.STREAM_CONCURRENCY) || 2; // Keep low to avoid HTTP 429 rate limits on AIOStreams
const STREAM_PACING_MS = Number(process.env.STREAM_PACING_MS) || 500; // Pause between stream probes to reduce addon load
const STREAM_PROBE_TIMEOUT_MS = Number(process.env.STREAM_PROBE_TIMEOUT_MS) || 12000; // Allow slower scraper/cache responses to finish
const ABORT_RETRY_DELAY_MS = 1200; // Pause before retrying after an AbortError

const auditLogs = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function loadStreamAvailability() {
  try {
    if (fs.existsSync(STREAM_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STREAM_STATE_FILE, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    }
  } catch {
    // Ignore malformed state file and start with an empty map
  }
  return {};
}

function saveStreamAvailability(stateMap) {
  const dir = path.dirname(STREAM_STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STREAM_STATE_FILE, JSON.stringify(stateMap, null, 2));
}

function extractStreamDate(streams, now = new Date()) {
  const todayStr = pacificDateString(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = pacificDateString(yesterday);

  let earliestFound = null;

  for (const s of streams || []) {
    if (!s || typeof s !== "object") continue;

    const rawProp = s.publishedAt || s.releaseDate || s.createdAt || s.timestamp || s.date;
    if (rawProp) {
      const parsed = new Date(rawProp);
      if (!Number.isNaN(parsed.getTime())) {
        const pacDate = pacificDateString(parsed);
        if (pacDate <= todayStr && (!earliestFound || pacDate < earliestFound)) {
          earliestFound = pacDate;
        }
      }
    }

    const text = `${s.name || ""} ${s.title || ""} ${s.description || ""}`;
    const isoMatches = text.match(/\b(202\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/g) || [];
    for (const d of isoMatches) {
      if (d <= todayStr && (!earliestFound || d < earliestFound)) {
        earliestFound = d;
      }
    }

    if (/\b(?:1d|yesterday)\b/i.test(text) && !isoMatches.length) {
      if (!earliestFound || yesterdayStr < earliestFound) {
        earliestFound = yesterdayStr;
      }
    }
  }

  return earliestFound;
}

/**
 * Checks the configured Stremio stream addon using STREAM_PROBE_TIMEOUT_MS
 * to see if the target episode has already dropped and is playable right now,
 * backing off on HTTP 429 and retrying once after a pause on AbortError.
 * Returns { playable: boolean, streamDate: string | null }.
 */
async function checkLiveStreams(imdbId, season, episode, debugLabel = "") {
  if (!STREAM_ADDON_URL || !imdbId || season == null || episode == null) {
    if (debugLabel) {
      console.log(`[STREAM DEBUG ${debugLabel}] Skipped probe (url=${Boolean(STREAM_ADDON_URL)}, imdbId=${imdbId}, s=${season}, e=${episode})`);
    }
    return { playable: false, streamDate: null };
  }

  const streamUrl = `${STREAM_ADDON_URL}/stream/series/${imdbId}:${season}:${episode}.json`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const timeoutForAttempt = attempt === 0 ? STREAM_PROBE_TIMEOUT_MS : STREAM_PROBE_TIMEOUT_MS + 3000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutForAttempt);

    try {
      const res = await fetch(streamUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 Stremio",
          "Accept": "application/json"
        }
      });

      if (res.status === 429) {
        const retryAfterSec = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 5000)
          : 1500 * (attempt + 1);
        if (debugLabel) {
          console.log(`[STREAM DEBUG ${debugLabel}] HTTP 429 for ${imdbId}:${season}:${episode} — backing off ${waitMs}ms (attempt ${attempt + 1}/2)`);
        }
        if (attempt === 0) {
          await sleep(waitMs);
          continue;
        }
        return { playable: false, streamDate: null };
      }

      if (!res.ok) {
        if (debugLabel) {
          console.log(`[STREAM DEBUG ${debugLabel}] HTTP ${res.status} for ${imdbId}:${season}:${episode}`);
        }
        return { playable: false, streamDate: null };
      }

      const data = await res.json();
      const rawCount = Array.isArray(data?.streams) ? data.streams.length : -1;

      if (!Array.isArray(data?.streams) || data.streams.length === 0) {
        if (debugLabel) {
          console.log(`[STREAM DEBUG ${debugLabel}] Empty streams array (${rawCount}) for ${imdbId}:${season}:${episode}`);
        }
        return { playable: false, streamDate: null };
      }

      const playableStreams = data.streams.filter(s => {
        if (!s || typeof s !== "object") return false;
        const label = `${s.name || ""} ${s.title || ""} ${s.description || ""}`;
        if (/no streams|not found|error|rate limit|addon error/i.test(label)) {
          return false;
        }
        return Boolean(s.url || s.infoHash || s.externalUrl || s.ytId || s.streamData);
      });

      const streamDate = playableStreams.length > 0 ? extractStreamDate(playableStreams) : null;

      if (debugLabel) {
        console.log(`[STREAM DEBUG ${debugLabel}] ${imdbId}:${season}:${episode} -> raw=${rawCount}, playable=${playableStreams.length}, streamDate=${streamDate || "none"}`);
      }

      return { playable: playableStreams.length > 0, streamDate };
    } catch (err) {
      if (debugLabel) {
        console.log(`[STREAM DEBUG ${debugLabel}] Probe failed for ${imdbId}:${season}:${episode} (attempt ${attempt + 1}/2, timeout=${timeoutForAttempt}ms): ${err?.name || "Error"} - ${err?.message || err}`);
      }
      if (err?.name === "AbortError" && attempt === 0) {
        await sleep(ABORT_RETRY_DELAY_MS);
        continue;
      }
      return { playable: false, streamDate: null };
    } finally {
      clearTimeout(timer);
    }
  }

  return { playable: false, streamDate: null };
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
  const availabilityState = loadStreamAvailability();

  console.log(`Discovering English adult shows from TMDB (${LOOKAHEAD_DAYS}-day lookahead + ${RETENTION_DAYS_BACK}-day window)...`);
  if (!STREAM_ADDON_URL) {
    console.warn("⚠️ STREAM_ADDON_URL not set — skipping live stream availability checks.");
  } else {
    console.log(`Using normalized STREAM_ADDON_URL: ${STREAM_ADDON_URL}`);
  }

  const now = new Date();
  const todayStr = pacificDateString(now);

  const maxFutureDate = new Date(now);
  maxFutureDate.setDate(maxFutureDate.getDate() + LOOKAHEAD_DAYS);
  const maxFutureStr = pacificDateString(maxFutureDate);

  const recentCutoffDate = new Date(now);
  recentCutoffDate.setDate(recentCutoffDate.getDate() - RECENT_FALLBACK_DAYS);
  const recentCutoffStr = pacificDateString(recentCutoffDate);

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

    const listedDate = discoveredDate;
    let sortDate = listedDate;

    const probeTargets = [];
    if (STREAM_ADDON_URL && imdbId) {
      if (lastEp && lastEpDate && lastEpDate >= recentCutoffStr) {
        probeTargets.push({ season: lastEp.season_number, episode: lastEp.episode_number });
      }

      if (nextEp && nextEpDate >= todayStr && nextEpDate <= maxFutureStr) {
        const alreadyQueued = probeTargets.some(
          t => t.season === nextEp.season_number && t.episode === nextEp.episode_number
        );
        if (!alreadyQueued) {
          probeTargets.push({ season: nextEp.season_number, episode: nextEp.episode_number });
        }
      }

      if (lastEp && (!nextEp || nextEpDate > maxFutureStr) && (audit.whitelisted || sortDate >= recentCutoffStr)) {
        const nextNum = (lastEp.episode_number || 0) + 1;
        const alreadyQueued = probeTargets.some(
          t => t.season === lastEp.season_number && t.episode === nextNum
        );
        if (!alreadyQueued) {
          probeTargets.push({ season: lastEp.season_number, episode: nextNum });
        }
      }
    }

    const debugLabel = `${showName} (#${tmdbId})`;

    return {
      tmdbId,
      showName,
      audit,
      debugLabel,
      imdbId,
      stremioId,
      tmdbDetails,
      tmdbMeta,
      lastEpDate,
      nextEpDate,
      listedDate,
      sortDate,
      probeTargets,
      streamVerified: false,
      streamAvailableDate: null,
      clampedToDate: null
    };
  });

  const activeCandidates = evaluated.filter(Boolean);
  const streamCheckTargets = activeCandidates.filter(item => item.probeTargets.length > 0);

  console.log(`Checking live streams for ${streamCheckTargets.length} shows (concurrency=${STREAM_CONCURRENCY}, pacing=${STREAM_PACING_MS}ms, timeout=${STREAM_PROBE_TIMEOUT_MS}ms)...`);

  await mapWithConcurrency(streamCheckTargets, STREAM_CONCURRENCY, async (item) => {
    for (const target of item.probeTargets) {
      await sleep(STREAM_PACING_MS);
      const { playable, streamDate } = await checkLiveStreams(item.imdbId, target.season, target.episode, item.debugLabel);
      if (playable) {
        const key = `${item.imdbId}:${target.season}:${target.episode}`;
        const savedDate = availabilityState[key];

        let availableDate = streamDate || savedDate || todayStr;
        if (streamDate && savedDate && savedDate < streamDate) {
          availableDate = savedDate;
        }
        if (!streamDate && savedDate && savedDate < todayStr) {
          availableDate = savedDate;
        }

        availabilityState[key] = availableDate;
        item.streamVerified = true;
        item.streamAvailableDate = availableDate;

        if (item.listedDate !== availableDate) {
          item.sortDate = availableDate;
          item.clampedToDate = availableDate;
        }
        break;
      }
    }
  });

  saveStreamAvailability(availabilityState);

  const metas = activeCandidates.map((item) => {
    const liveBadge = item.streamVerified
      ? (item.clampedToDate ? `YES (Clamped ${item.listedDate} -> ${item.clampedToDate})` : `YES (${item.streamAvailableDate})`)
      : "-";

    auditLogs.push({
      name: item.showName,
      status: "KEPT",
      sortDate: item.sortDate,
      liveStream: liveBadge,
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
      _sortDate: item.sortDate,
      _streamVerified: item.streamVerified
    };
  });

  metas.sort((a, b) => {
    if (a._streamVerified !== b._streamVerified) {
      return a._streamVerified ? -1 : 1;
    }
    if (a._streamVerified && b._streamVerified) {
      return b._sortDate.localeCompare(a._sortDate);
    }

    const aIsFuture = a._sortDate > todayStr;
    const bIsFuture = b._sortDate > todayStr;

    if (aIsFuture !== bIsFuture) {
      return aIsFuture ? 1 : -1;
    }

    return aIsFuture
      ? a._sortDate.localeCompare(b._sortDate)
      : b._sortDate.localeCompare(a._sortDate);
  });

  metas.forEach(show => {
    delete show._sortDate;
    delete show._streamVerified;
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
