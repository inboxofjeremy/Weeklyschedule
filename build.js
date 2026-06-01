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
// TVMAZE RATE LIMIT
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

      if (wait) {
        await new Promise(r => setTimeout(r, wait));
      }

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

function pacificDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;

  return `${y}-${m}-${d}`;
}

// ===============================
// FILTERS (UNCHANGED)
// ===============================
function isSports(show) {
  return (
    (show.type || "").toLowerCase() === "sports" ||
    (show.genres || []).some(g => g?.toLowerCase() === "sports")
  );
}

function isNews(show) {
  const t = (show.type || "").toLowerCase();

  const isPanel = (show.genres || []).some(g =>
    ["panel", "quiz", "game show"].includes(g?.toLowerCase())
  );

  if (isPanel) return false;

  return t === "news" || t === "talk show";
}

function isForeign(show) {
  const allowed = ["US", "GB", "CA", "AU", "IE", "NZ"];

  const c =
    show?.network?.country?.code ||
    show?.webChannel?.country?.code ||
    "";

  return c && !allowed.includes(c.toUpperCase());
}

function isBlockedWebChannel(show) {
  return (show?.webChannel?.name || "").toLowerCase() === "iqiyi";
}

function isYouTubeShow(show) {
  return (show?.webChannel?.name || "")
    .toLowerCase()
    .includes("youtube");
}

function isDocumentary(show) {
  return (
    (show.type || "").toLowerCase() === "documentary" ||
    (show.genres || []).some(g => g?.toLowerCase() === "documentary")
  );
}

function isBlockedPlatform(show) {
  return (show?.webChannel?.name || "").toLowerCase() === "tubi";
}

function isLegal(show) {
  return (show.genres || []).some(g => g?.toLowerCase() === "legal");
}

function isBlockedLanguage(show) {
  const blocked = [
    "italian","turkish","indonesian","spanish","thai",
    "arabic","norwegian","german","chinese","korean",
    "french","hindi"
  ];

  return blocked.includes((show.language || "").toLowerCase());
}

// ===============================
// MAIN BUILD
// ===============================
async function build() {
  const showMap = new Map();

  // ===============================
  // COLLECT SHOWS
  // ===============================
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);

    const dateStr = pacificDateString(d);

    const list = await fetchJSON(
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`
    );

    if (!Array.isArray(list)) continue;

    for (const ep of list) {
      const show = ep.show || ep._embedded?.show;
      if (!show?.id) continue;

      if (
        isSports(show) ||
        isForeign(show) ||
        isBlockedLanguage(show) ||
        isDocumentary(show) ||
        isBlockedWebChannel(show) ||
        isYouTubeShow(show) ||
        isLegal(show) ||
        isBlockedPlatform(show) ||
        isNews(show)
      ) {
        continue;
      }

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

  // ===============================
  // BUILD OUTPUT
  // ===============================
  const metas = [];

  for (const entry of showMap.values()) {
    const imdb = entry.show?.externals?.imdb || null;

    const tmdbId = null; // unchanged behavior
    const stremioId = imdb || `tvmaze:${entry.show.id}`;

    const recent = entry.episodes;

    if (!recent.length) continue;

    recent.sort(
      (a, b) =>
        new Date(getStrictEpisodeDate(a)) -
        new Date(getStrictEpisodeDate(b))
    );

    // ===============================
    // ✅ TVMAZE ONLY EPISODE METADATA
    // ===============================
    const videos = recent.map(ep => ({
      id:
        `${stremioId}:` +
        `${ep.season || 0}:` +
        `${ep.number || ep.id}`,

      title: ep.name,

      season: ep.season || 0,
      episode: ep.number || 0,

      released: getStrictEpisodeDate(ep),

      // ONLY TVMAZE (no TMDB fallback)
      overview: cleanHTML(ep.summary)
    }));

    metas.push({
      id: stremioId,
      type: "series",
      name: entry.show.name,

      description: cleanHTML(entry.show.summary),

      poster:
        entry.show.image?.original ||
        entry.show.image?.medium ||
        null,

      background:
        entry.show.image?.original || null,

      videos
    });
  }

  // ===============================
  // SORT METAS
  // ===============================
  metas.sort(
    (a, b) =>
      new Date(b.videos[b.videos.length - 1]?.released || 0) -
      new Date(a.videos[a.videos.length - 1]?.released || 0)
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
