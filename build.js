import fs from "fs";
import path from "path";

const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const CATALOG_DIR = path.join("./", "catalog", "series");
const DAYS_BACK = 10;

const TVMAZE_DELAY_MS = 150;
let lastTvmazeCall = 0;

// =======================
// FETCH
// =======================
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

// =======================
// HELPERS
// =======================
const cleanHTML = s =>
  s ? s.replace(/<[^>]+>/g, "").trim() : "";

// =======================
// FILTERS (RESTORED)
// =======================
function isBlockedLanguage(show) {
  const blocked = [
    "italian","turkish","indonesian","spanish","thai",
    "arabic","norwegian","german","chinese","korean",
    "french","hindi"
  ];

  return blocked.includes((show.language || "").toLowerCase());
}

function isNews(show) {
  const t = (show.type || "").toLowerCase();
  return t === "news" || t === "talk show";
}

function isSports(show) {
  return (show.type || "").toLowerCase() === "sports";
}

// =======================
// MAIN
// =======================
async function build() {
  const showMap = new Map();

  // =======================
  // COLLECT SHOW IDS
  // =======================
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

      showMap.set(show.id, show);
    }
  }

  // =======================
  // BUILD METAS
  // =======================
  const metas = [];

  for (const [id, show] of showMap.entries()) {
    const full = await fetchJSON(
      `https://api.tvmaze.com/shows/${id}?embed=episodes`
    );

    if (!full?._embedded?.episodes) continue;

    // ✅ FIX: stable ID (IMPORTANT)
    const imdb = full.externals?.imdb;

    const stremioId =
      imdb ? `tt:${imdb}` : `tvmaze:${id}`;

    const episodes = full._embedded.episodes
      .filter(e => e.airdate)
      .sort((a, b) => new Date(a.airdate) - new Date(b.airdate));

    const videos = episodes.map(ep => ({
      id: `${stremioId}:${ep.season}:${ep.number}`,
      title: ep.name,
      season: ep.season,
      episode: ep.number,
      released: ep.airdate,
      overview: cleanHTML(ep.summary)
    }));

    metas.push({
      id: stremioId,
      type: "series",
      name: full.name,
      description: cleanHTML(full.summary),
      poster: full.image?.original || full.image?.medium || null,
      background: full.image?.original || null,
      videos
    });
  }

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
