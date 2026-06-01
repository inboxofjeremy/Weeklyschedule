import fs from "fs";
import path from "path";

const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";

const OUT_DIR = "./public";
const CATALOG_DIR = path.join(OUT_DIR, "catalog", "series");
const META_DIR = path.join(OUT_DIR, "meta", "series");

const DAYS_BACK = 10;

// =====================
// FETCH
// =====================
async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// =====================
// CLEAN
// =====================
const cleanHTML = s => (s ? s.replace(/<[^>]+>/g, "").trim() : "");

// =====================
// DATE
// =====================
function getStrictEpisodeDate(ep) {
  return ep?.airdate && ep.airdate !== "0000-00-00"
    ? ep.airdate
    : ep?.airstamp?.slice(0, 10) || null;
}

// =====================
// WINDOW FILTER
// =====================
function isInWindow(epDate) {
  if (!epDate) return false;

  const today = new Date();
  const start = new Date();
  start.setDate(today.getDate() - (DAYS_BACK - 1));

  const d = new Date(epDate + "T00:00:00Z");

  return d >= start && d <= today;
}

// =====================
// TMDB LOOKUP
// =====================
async function findTmdbId(show) {
  const imdb = show?.externals?.imdb;
  if (!imdb) return null;

  const data = await fetchJSON(
    `https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
  );

  return data?.tv_results?.[0]?.id || null;
}

// =====================
// MAIN
// =====================
async function build() {
  const showMap = new Map();

  const schedule = await fetchJSON(
    `https://api.tvmaze.com/schedule?country=US&date=${new Date().toISOString().slice(0, 10)}`
  );

  if (!Array.isArray(schedule)) {
    console.log("No schedule");
    return;
  }

  for (const ep of schedule) {
    const show = ep.show;
    if (!show?.id) continue;

    if (!showMap.has(show.id)) {
      showMap.set(show.id, { show, episodes: [] });
    }

    showMap.get(show.id).episodes.push(ep);
  }

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.mkdirSync(META_DIR, { recursive: true });

  const metas = [];

  for (const { show, episodes } of showMap.values()) {
    const tmdbId = await findTmdbId(show);

    const id = tmdbId
      ? `tmdb:${tmdbId}`
      : `tmdb:${900000000 + show.id}`;

    const videos = episodes
      .filter(ep => isInWindow(getStrictEpisodeDate(ep)))
      .map(ep => ({
        id: `${id}:${ep.season}:${ep.number}`,
        title: ep.name,
        season: ep.season,
        episode: ep.number,
        released: getStrictEpisodeDate(ep),
        overview: cleanHTML(ep.summary)
      }))
      .sort((a, b) => new Date(a.released) - new Date(b.released));

    if (!videos.length) continue;

    const meta = {
      id,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),
      poster: show.image?.original,
      background: show.image?.original,
      videos
    };

    metas.push(meta);

    // =====================
    // META FILE (CRITICAL)
    // =====================
    fs.writeFileSync(
      path.join(META_DIR, `${id}.json`),
      JSON.stringify({ meta }, null, 2)
    );
  }

  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas }, null, 2)
  );

  console.log("Build complete:", metas.length);
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
