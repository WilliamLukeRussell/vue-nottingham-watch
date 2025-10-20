// scrape.mjs — Vue Nottingham via SerpAPI Google Search (parses `showtimes`)
import fs from "node:fs/promises";

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// helpers
const toMins = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return Number.POSITIVE_INFINITY;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
};
const pad = (n) => String(n).padStart(2, "0");
const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

// fetch Google Search (NOT google_showtimes) and read `showtimes`
async function fetchShowtimes() {
  if (!SERPAPI_KEY) throw new Error("Missing SERPAPI_KEY");
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", "Vue Nottingham showtimes");
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "gb");
  url.searchParams.set("location", "Nottingham, United Kingdom");
  url.searchParams.set("api_key", SERPAPI_KEY);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
  return await res.json();
}

function buildTodayBlock(rows) {
  return rows.map(r => `${r.start.padStart(5, " ")}  ${r.film}`).join("\n");
}

(async () => {
  const now = new Date();
  const nowM = now.getHours() * 60 + now.getMinutes();

  let today_showings = [];
  let error = null;

  try {
    const data = await fetchShowtimes();

    // SerpAPI returns showtimes under data.showtimes[...]
    // (structure varies: sometimes `theaters[…].movies`, sometimes `movies` at the top)
    const st = data.showtimes || [];
    // Try find a block for Vue Nottingham by name/address text
    // Two shapes exist in docs: day->theaters or day->movies; handle both.
    for (const dayBlock of st) {
      // theaters shape
      if (Array.isArray(dayBlock.theaters)) {
        const vue = dayBlock.theaters.find(t =>
          /vue\b/i.test(t.name || "") && /nottingham/i.test(((t.address || "") + " " + (t.name || "")))
        ) || null;
        if (vue && Array.isArray(vue.movies)) {
          for (const mv of vue.movies) {
            const title = (mv.name || "").trim();
            const showings = mv.showing || mv.showtimes || [];
            for (const s of showings) {
              const times = Array.isArray(s.time) ? s.time : (s.time ? [s.time] : []);
              const times24 = Array.isArray(s.time_24) ? s.time_24 : (s.time_24 ? [s.time_24] : []);
              const normalized = (times24.length ? times24 : times).map(t => t.replace(/\s*(am|pm)\s*/i,""));
              for (const start of normalized) {
                if (/^\d{1,2}:\d{2}$/.test(start)) {
                  today_showings.push({ film: title, screen: null, start, end: null });
                }
              }
            }
          }
        }
      }
      // movies-at-top shape
      if (Array.isArray(dayBlock.movies)) {
        for (const mv of dayBlock.movies) {
          const title = (mv.name || "").trim();
          const showings = mv.showing || mv.showtimes || [];
          for (const s of showings) {
            const times = Array.isArray(s.time) ? s.time : (s.time ? [s.time] : []);
            const times24 = Array.isArray(s.time_24) ? s.time_24 : (s.time_24 ? [s.time_24] : []);
            const normalized = (times24.length ? times24 : times).map(t => t.replace(/\s*(am|pm)\s*/i,""));
            for (const start of normalized) {
              if (/^\d{1,2}:\d{2}$/.test(start)) {
                today_showings.push({ film: title, screen: null, start, end: null });
              }
            }
          }
        }
      }
    }
  } catch (e) {
    error = String(e?.message || e);
    console.error("SerpAPI error:", error);
  }

  // Sort + compute next/finishing
  today_showings.sort((a, b) => toMins(a.start) - toMins(b.start));

  const next_starting = today_showings.find(s => toMins(s.start) > nowM) || null;

  const withEnds = today_showings.map(s => ({
    ...s,
    _startM: toMins(s.start),
    _endM: toMins(s.start) + 120, // rough duration if end unknown
  }));
  const current = withEnds
    .filter(s => s._startM <= nowM && s._endM > nowM)
    .sort((a, b) => a._endM - b._endM)[0] || null;

  const next_finishing = current
    ? { film: current.film, screen: null, start: fmt(current._startM), end: fmt(current._endM) }
    : null;

  const out = {
    generated_at: now.toISOString(),
    ...(error ? { error } : {}),
    next_starting,
    next_finishing,
    today_showings,
    today_block: buildTodayBlock(today_showings),
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile("public/vue-nottingham.json", JSON.stringify(out, null, 2));
  console.log(`✅ Published vue-nottingham.json with ${today_showings.length} rows`);
})();
