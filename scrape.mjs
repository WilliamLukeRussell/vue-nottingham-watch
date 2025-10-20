// scrape.mjs — Vue Nottingham showtimes via SerpAPI (no screen numbers)
// Publishes: public/vue-nottingham.json (+ today_block for easy listing)
import fs from "node:fs/promises";

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const QUERY = "Vue Nottingham showtimes";

function toMins(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return Number.POSITIVE_INFINITY;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

async function fetchShowtimes() {
  if (!SERPAPI_KEY) throw new Error("Missing SERPAPI_KEY");
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_showtimes");
  url.searchParams.set("q", QUERY);
  url.searchParams.set("hl", "en");   // UI language
  url.searchParams.set("gl", "gb");   // results region
  url.searchParams.set("api_key", SERPAPI_KEY);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
  return await res.json();
}

function buildTodayBlock(rows) {
  // Pretty one-text list for Widgy if you don’t want to loop arrays
  // Format: "HH:MM  Title" each on a new line
  return rows.map(r => `${r.start.padStart(5, " ")}  ${r.film}`).join("\n");
}

(async () => {
  const now = new Date();
  const nowM = now.getHours() * 60 + now.getMinutes();

  let today_showings = [];
  let error = null;

  try {
    const data = await fetchShowtimes();

    // SerpAPI returns an array of theaters; pick the Vue Nottingham one
    const theaters = data.showtimes?.theaters || data.theaters || [];
    const vue = theaters.find(t =>
      /vue\b/i.test(t.name || "") && /nottingham/i.test(((t.address || "") + " " + (t.name || ""))
    )) || theaters[0];

    if (vue && vue.movies) {
      for (const mv of vue.movies) {
        const title = (mv.name || "").trim();
        const slots = (mv.showing || mv.showtimes || []).map(s => (s.time_24 || s.time || "").trim());
        const times = slots.filter(t => /^\d{1,2}:\d{2}$/.test(t));
        for (const start of times) {
          today_showings.push({ film: title, screen: null, start, end: null });
        }
      }
    }
  } catch (e) {
    error = String(e?.message || e);
    console.error("SerpAPI error:", error);
  }

  // sort and compute nexts
  today_showings.sort((a, b) => toMins(a.start) - toMins(b.start));

  const next_starting = today_showings.find(s => toMins(s.start) > nowM) || null;

  const withEnds = today_showings.map(s => ({
    ...s,
    _startM: toMins(s.start),
    _endM: toMins(s.start) + 120, // assume ~120 min where end unknown
  }));

  const current = withEnds
    .filter(s => s._startM <= nowM && s._endM > nowM)
    .sort((a, b) => a._endM - b._endM)[0] || null;

  const pad = n => String(n).padStart(2, "0");
  const fmt = m => `${pad(Math.floor(m/60))}:${pad(m%60)}`;

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
