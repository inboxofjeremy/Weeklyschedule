import fs from "fs";
import path from "path";

const BASE = "./";
const CATALOG_DIR = path.join(BASE, "catalog", "series");
const META_DIR = path.join(BASE, "meta", "series");

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

async function build() {
  const showMap = new Map();

  // =========================
  // COLLECT SHOWS
  // =========================
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);

    const date = d.toISOString().slice(0, 10);

    const schedule = await fetchJSON(
      `https://api.tvmaze.com/schedule?country=US&date=${date}`
    );

    if (!Array.isArray(schedule)) continue;

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
  }

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  fs.mkdirSync(META_DIR, { recursive: true });

  const metas = [];

  // =========================
  // BUILD META FILES
  // =========================
  for (const { show, episodes } of showMap.values()) {
    const id = `tvmaze:${show.id}`;

    const videos = [];
    const seen = new Set();

    for (const ep of episodes) {
      const key = `${ep.season}-${ep.number}`;
      if (seen.has(key)) continue;
      seen.add(key);

      videos.push({
        id: `${id}:${ep.season}:${ep.number}`,
        title: ep.name || `Episode ${ep.number}`,
        season: ep.season,
        episode: ep.number,
        released: ep.airdate,
        overview: clean(ep.summary || "")
      });
    }

    const metaObj = {
      meta: {
        id,
        type: "series",
        name: show.name,
        description: clean(show.summary),

        poster: show.image?.original || show.image?.medium || null,
        background: show.image?.original || null,

        videos
      }
    };

    // WRITE META FILE
    fs.writeFileSync(
      path.join(META_DIR, `${id}.json`),
      JSON.stringify(metaObj, null, 2)
    );

    metas.push(metaObj.meta);
  }

  // =========================
  // WRITE CATALOG
  // =========================
  fs.writeFileSync(
    path.join(CATALOG_DIR, "tvmaze_weekly_schedule.json"),
    JSON.stringify({ metas }, null, 2)
  );

  console.log("Built catalog + meta files:", metas.length);
}

build();
