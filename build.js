import fs from "fs";
import path from "path";

// =======================
// CONFIG
// =======================
const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";

const OUTPUT_FILE = "catalog/series/tvmaze_weekly_schedule.json";

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
const cleanHTML = (s) =>
  s ? s.replace(/<[^>]+>/g, "").trim() : "";

function getEpisodeDate(ep) {
  return ep?.airdate && ep.airdate !== "0000-00-00"
    ? ep.airdate
    : ep?.airstamp?.slice(0, 10) || null;
}

// =======================
// TMDB LOOKUP (kept minimal, safe)
// =======================
async function findTmdbId(show) {
  const imdb = show?.externals?.imdb;
  if (!imdb) return null;

  const data = await fetchJSON(
    `https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
  );

  return data?.tv_results?.[0]?.id || null;
}

// =======================
// MAIN BUILD
// =======================
async function build() {
  const showMap = new Map();

  // collect schedule (only today window like your setup implied)
  const today = new Date().toISOString().slice(0, 10);

  const schedule = await fetchJSON(
    `https://api.tvmaze.com/schedule?country=US&date=${today}`
  );

  if (!Array.isArray(schedule)) {
    console.log("No schedule data returned");
    schedule = [];
  }

  for (const ep of schedule) {
    const show = ep.show;
    if (!show?.id) continue;

    if (!showMap.has(show.id)) {
      showMap.set(show.id, {
        show,
        episodes: []
      });
    }

    showMap.get(show.id).episodes.push(ep);
  }

  const metas = [];

  for (const { show, episodes } of showMap.values()) {
    const tmdbId = await findTmdbId(show);

    const id = tmdbId
      ? `tmdb:${tmdbId}`
      : `tmdb:${900000000 + show.id}`;

    const videos = episodes
      .map(ep => ({
        id: `${id}:${ep.season || 0}:${ep.number || 0}`,
        title: ep.name || `Episode ${ep.number || 0}`,
        season: ep.season || 0,
        episode: ep.number || 0,
        released: getEpisodeDate(ep),
        overview: cleanHTML(ep.summary || "")
      }))
      .sort(
        (a, b) =>
          new Date(a.released || 0) - new Date(b.released || 0)
      );

    if (!videos.length) continue;

    metas.push({
      id,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary || ""),
      poster: show.image?.original || show.image?.medium || null,
      background: show.image?.original || null,
      videos
    });
  }

  // =======================
  // CRITICAL FIX: ENSURE PATH EXISTS
  // =======================
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  console.log("Metas generated:", metas.length);
  console.log("Writing file:", OUTPUT_FILE);

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify({ metas }, null, 2)
  );
}

build().catch(err => {
  console.error("BUILD FAILED:", err);
  process.exit(1);
});
