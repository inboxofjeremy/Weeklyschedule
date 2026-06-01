import fs from "fs";
import path from "path";

// ===============================
// CONFIG
// ===============================
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const OUT_DIR = "./";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");
const DAYS_BACK = 10;

// ===============================
// RATE LIMIT
// ===============================
const TVMAZE_DELAY_MS = 150;
let lastTvmazeCall = 0;

async function fetchJSON(url) {
  try {
    if (url.includes("api.tvmaze.com")) {
      const wait = Math.max(
        0,
        TVMAZE_DELAY_MS - (Date.now() - lastTvmazeCall)
      );
      if (wait) await new Promise(r => setTimeout(r, wait));
      lastTvmazeCall = Date.now();
    }

    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ===============================
// HELPERS
// ===============================
const cleanHTML = s =>
  s ? s.replace(/<[^>]+>/g, "").trim() : "";

function getStrictEpisodeDate(ep) {
  return ep?.airdate && ep.airdate !== "0000-00-00"
    ? ep.airdate
    : ep?.airstamp?.slice(0, 10) || null;
}

// ===============================
// FILTERS (UNCHANGED)
// ===============================
function isBlockedLanguage(show) {
  const blocked = [
    "italian","turkish","indonesian","spanish","thai",
    "arabic","norwegian","german","chinese","korean",
    "french","hindi"
  ];
  return blocked.includes((show.language || "").toLowerCase());
}

function isNews(show) {
  return (show.type || "").toLowerCase() === "news";
}

function isSports(show) {
  return (show.type || "").toLowerCase() === "sports";
}

// ===============================
// TMDB MAPPING (CRITICAL FIX)
// ===============================
async function findTmdbId(show) {
  const imdb = show?.externals?.imdb;
  if (!imdb) return null;

  const url =
    `https://api.themoviedb.org/3/find/${imdb}` +
    `?api_key=${TMDB_API_KEY}&external_source=imdb_id`;

  const data = await fetchJSON(url);

  return data?.tv_results?.[0]?.id || null;
}

// ===============================
// MAIN
// ===============================
async function build() {
  const showMap = new Map();

  // STEP 1: collect shows
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);

    const dateStr = d.toISOString().slice(0, 10);

    const schedule = await fetchJSON(
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`
    );

    if (!Array.isArray(schedule)) continue;

    for (const ep of schedule) {
      const show = ep.show;
      if (!show?.id) continue;

      if (
        isBlockedLanguage(show) ||
        isNews(show) ||
        isSports(show)
      ) continue;

      if (!showMap.has(show.id)) {
        showMap.set(show.id, {
          show,
          episodes: [ep]
        });
      } else {
        showMap.get(show.id).episodes.push(ep);
      }
    }
  }

  const metas = [];

  // STEP 2: build output
  for (const entry of showMap.values()) {
    const show = entry.show;

    // ==========================
    // 🔑 TMDB IS PRIMARY ID
    // ==========================
    const tmdbId = await findTmdbId(show);
    if (!tmdbId) continue;

    const stremioId = `tmdb:${tmdbId}`;

    const episodes = entry.episodes
      .filter(ep => ep?.airdate)
      .sort((a, b) => {
        const aDate = getStrictEpisodeDate(a);
        const bDate = getStrictEpisodeDate(b);
        return new Date(aDate) - new Date(bDate);
      });

    const videos = episodes.map(ep => ({
      id: `${stremioId}:${ep.season}:${ep.number}`,
      title: ep.name,
      season: ep.season || 0,
      episode: ep.number || 0,
      released: getStrictEpisodeDate(ep),
      overview: cleanHTML(ep.summary)
    }));

    metas.push({
      id: stremioId,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),

      poster:
        show.image?.original ||
        show.image?.medium ||
        null,

      background:
        show.image?.original || null,

      videos
    });
  }

  // newest first
  metas.sort((a, b) =>
    new Date(b.videos.at(-1)?.released || 0) -
    new Date(a.videos.at(-1)?.released || 0)
  );

  fs.mkdirSync(CATALOG_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas }, null, 2)
  );

  console.log("Build complete:", metas.length, "shows");
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
