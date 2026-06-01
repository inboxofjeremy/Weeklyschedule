import fs from "fs";
import path from "path";

const CATALOG_DIR = path.join("./", "catalog", "series");
const DAYS_BACK = 10;

// =======================
// FETCH
// =======================
async function fetchJSON(url) {
  try {
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
const cleanHTML = s => s ? s.replace(/<[^>]+>/g, "").trim() : "";

// =======================
// FILTERS (kept safe + stable)
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
  return (show.type || "").toLowerCase() === "news";
}

function isSports(show) {
  return (show.type || "").toLowerCase() === "sports";
}

// =======================
// MAIN
// =======================
async function build() {
  const showMap = new Map();

  // STEP 1: collect show IDs from schedule
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

  const metas = [];

  // STEP 2: build full metadata per show
  for (const [id] of showMap.entries()) {
    const full = await fetchJSON(
      `https://api.tvmaze.com/shows/${id}?embed=episodes`
    );

    if (!full?._embedded?.episodes) continue;

    // ✅ FIX: ALWAYS use TVMaze as stable ID
    const metaId = `tvmaze:${id}`;

    const episodes = full._embedded.episodes
      .filter(e => e?.airdate)
      .sort((a, b) =>
        new Date(a.airdate) - new Date(b.airdate)
      );

    const videos = episodes.map(ep => ({
      id: `${metaId}:${ep.season}:${ep.number}`,
      title: ep.name,
      season: ep.season,
      episode: ep.number,
      released: ep.airdate,
      overview: cleanHTML(ep.summary)
    }));

    // safer latest episode calculation
    const latestDate = episodes.at(-1)?.airdate || "1970-01-01";

    metas.push({
      id: metaId, // ✅ ONLY identity used by Stremio
      type: "series",
      name: full.name,
      description: cleanHTML(full.summary),

      // metadata only (NOT identity)
      imdb: full.externals?.imdb || null,
      tmdb: null,

      poster: full.image?.original || full.image?.medium || null,
      background: full.image?.original || null,

      videos
    });
  }

  metas.sort(
    (a, b) =>
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
