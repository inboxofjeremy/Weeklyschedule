import fs from "fs";
import path from "path";

// CONFIG: Everything now writes to the 'public' folder
const OUT_DIR = "public";
const CATALOG_FILE = path.join(OUT_DIR, "catalog/series/tvmaze_weekly_schedule.json");
const META_DIR = path.join(OUT_DIR, "meta/series");
const DAYS_BACK = 10;

// ... [Keep your existing fetchJSON, cleanHTML, and getStrictEpisodeDate functions here] ...

async function build() {
  const showMap = new Map();
  // ... [Keep your existing fetch logic here] ...

  // Ensure directories exist
  fs.mkdirSync(path.join(OUT_DIR, "catalog/series"), { recursive: true });
  fs.mkdirSync(META_DIR, { recursive: true });

  const metas = [];

  for (const entry of showMap.values()) {
    const show = entry.show;
    const stremioId = `tvmaze${show.id}`;
    
    // ... [Keep your existing videos mapping logic here] ...

    const metaObj = {
      id: stremioId,
      type: "series",
      name: show.name,
      description: cleanHTML(show.summary),
      poster: show.image?.original || show.image?.medium || null,
      background: show.image?.original || null,
      genres: show.genres?.length ? show.genres : ["TV"],
      posterShape: "poster",
      videos
    };

    metas.push(metaObj);

    fs.writeFileSync(
      path.join(META_DIR, `${stremioId}.json`),
      JSON.stringify({ meta: metaObj }, null, 2)
    );
  }

  fs.writeFileSync(CATALOG_FILE, JSON.stringify({ metas }, null, 2));
  console.log(`Build complete in ${OUT_DIR}/`);
}

build().catch(err => { console.error(err); process.exit(1); });
