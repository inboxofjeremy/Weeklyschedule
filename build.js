import fs from "fs";
import path from "path";

const TMDB_API_KEY = "944017b839d3c040bdd2574083e4c1bc";

const CATALOG_DIR = path.join("catalog", "series");
const META_DIR = path.join("meta", "series");

const DAYS_BACK = 10;

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const clean = s => (s ? s.replace(/<[^>]+>/g, "").trim() : "");

function getDate(ep) {
  return ep?.airdate || ep?.airstamp?.slice(0, 10) || null;
}

async function findTmdbId(show) {
  const imdb = show?.externals?.imdb;
  if (!imdb) return null;

  const data = await fetchJSON(
    `https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
  );

  return data?.tv_results?.[0]?.id || null;
}

async function build() {
  const showMap = new Map();

  const schedule = await fetchJSON(
    `https://api.tvmaze.com/schedule?country=US&date=${new Date().toISOString().slice(0,10)}`
  );

  if (!Array.isArray(schedule)) {
    console.log("No schedule data");
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

    const videos = episodes.map(ep => ({
      id: `${id}:${ep.season}:${ep.number}`,
      title: ep.name,
      season: ep.season,
      episode: ep.number,
      released: getDate(ep),
      overview: clean(ep.summary)
    }));

    const meta = {
      id,
      type: "series",
      name: show.name,
      description: clean(show.summary),
      poster: show.image?.original,
      background: show.image?.original,
      videos
    };

    metas.push(meta);

    // META FILE (optional but now consistent)
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
  console.error("BUILD FAILED:", err);
  process.exit(1);
});
