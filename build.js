import fs from "fs";
import path from "path";

const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";
const CATALOG_DIR = path.join("./", "catalog", "series");
const DAYS_BACK = 10;

const tmdbCache = new Map();

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function cleanHTML(s) {
  return s ? s.replace(/<[^>]+>/g, "").trim() : "";
}

// --------------------
// SHOW FILTER SIGNAL ONLY
// --------------------
function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return `${parts[0].value}-${parts[2].value}-${parts[4].value}`;
}

// --------------------
// TMDB ID (unchanged)
// --------------------
async function getTmdbId(show) {
  if (tmdbCache.has(show.id)) return tmdbCache.get(show.id);

  const url =
    `https://api.themoviedb.org/3/search/tv` +
    `?api_key=${TMDB_API_KEY}` +
    `&query=${encodeURIComponent(show.name)}`;

  const data = await fetchJSON(url);

  const id = data?.results?.[0]?.id || null;
  tmdbCache.set(show.id, id);

  return id;
}

// --------------------
// FULL EPISODES (correct source)
// --------------------
async function getAllEpisodes(showId) {
  return await fetchJSON(
    `https://api.tvmaze.com/shows/${showId}/episodes`
  );
}

// --------------------
// BUILD
// --------------------
async function build() {
  const showMap = new Map();

  // STEP 1: ONLY detect recent activity via schedule
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);

    const dateStr = pacificDateString(d);

    const list = await fetchJSON(
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`
    );

    if (!Array.isArray(list)) continue;

    for (const ep of list) {
      const show = ep.show;
      if (!show?.id) continue;

      // only mark show as active
      showMap.set(show.id, {
        show,
        lastSeen: dateStr,
        episodes: null
      });
    }
  }

  // STEP 2: FULL EPISODES (always complete season)
  for (const entry of showMap.values()) {
    const eps = await getAllEpisodes(entry.show.id);
    entry.episodes = Array.isArray(eps) ? eps : [];
  }

  // STEP 3: TMDB ID only
  for (const entry of showMap.values()) {
    const tmdbId = await getTmdbId(entry.show);

    entry.stremioId = tmdbId
      ? `tmdb:${tmdbId}`
      : `tvmaze:${entry.show.id}`;
  }

  // STEP 4: OUTPUT
  const metas = [];

  for (const entry of showMap.values()) {
    const videos = entry.episodes
      .filter(e => e?.name)
      .sort((a, b) => a.number - b.number)
      .map(ep => ({
        id: `${entry.stremioId}:${ep.season}:${ep.number}`,
        title: ep.name,
        season: ep.season,
        episode: ep.number,
        released: ep.airdate,
        overview: cleanHTML(ep.summary)
      }));

    metas.push({
      id: entry.stremioId,
      type: "series",
      name: entry.show.name,
      description: cleanHTML(entry.show.summary),
      poster: entry.show.image?.original || null,
      videos
    });
  }

  // STEP 5: SORT BY LAST ACTIVITY (FIXED STABLE)
  metas.sort((a, b) => {
    const aDate = new Date(a.videos.at(-1)?.released || 0);
    const bDate = new Date(b.videos.at(-1)?.released || 0);
    return bDate - aDate;
  });

  fs.mkdirSync(CATALOG_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas }, null, 2)
  );

  console.log("Build complete:", metas.length);
}

build().catch(console.error);
