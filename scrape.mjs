// scrape.mjs — Vue Nottingham via IMDb (through Jina Reader, no headless, no keys)
// Publishes: public/vue-nottingham.json + robust even if one URL fails.

import fs from "node:fs/promises";

// IMDb cinema id for Vue Nottingham (ci1043282). We'll try a few postcode variants.
const IMDB_BASES = [
  "https://www.imdb.com/showtimes/cinema/GB/ci1043282/GB/NG1/",
  "https://www.imdb.com/showtimes/cinema/GB/ci1043282/GB/NG7/",
  "https://www.imdb.com/showtimes/cinema/GB/ci1043282/GB/NG8/",
  "https://www.imdb.com/showtimes/cinema/UK/ci1043282/UK/NG1/",
  "https://www.imdb.com/showtimes/cinema/UK/ci1043282/UK/NG7/",
  "https://www.imdb.com/showtimes/cinema/UK/ci1043282/UK/NG8/",
];

// Use Jina Reader proxy to fetch HTML as plain text (bypasses JS / bot checks)
const proxify = (url) => `https://r.jina.ai/http://` + url.replace(/^https?:\/\//, "");

// helpers
const toMins12 = (t) => {
  // "10:45 AM" or "9:05PM" -> minutes since midnight
  const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return Number.POSITIVE_INFINITY;
  let h = +m[1], min = +m[2];
  const ap = m[3].toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + min;
};
const toClock24 = (mins) => {
  mins = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

function parseImdb(html) {
  // Very tolerant parse:
  // - Titles appear near <h3>…<a>Title</a>…</h3> or data-testid bits.
  // - Times are in 12h with AM/PM in the same block.
  const blocks = html.split(/<h3[^>]*>/i);
  const showings = [];

  for (const block of blocks) {
    // title
    const title =
      (block.match(/<a[^>]*>([^<]+)<\/a>\s*<\/h3>/i)?.[1] ||
       block.match(/data-testid="title"[^>]*>([^<]+)</i)?.[1] ||
       block.match(/<h2[^>]*>([^<]+)<\/h2>/i)?.[1] ||
       "").trim();
    if (!title || title.length < 2) continue;

    // times in AM/PM (IMDb lists like "10:45 AM  1:15 PM  9:05 PM")
    const times = Array.from(block.matchAll(/\b(\d{1,2}:\d{2})\s*(AM|PM)\b/gi))
      .map(m => `${m[1]} ${m[2].toUpperCase()}`);

    for (const t of times) {
      showings.push({ film: title, start12: t });
    }
  }

  // Normalize to 24h strings for sorting and output
  const rows = showings
    .map(s => {
      const mins = toMins12(s.start12);
      return mins === Number.POSITIVE_INFINITY ? null : {
        film: s.film,
        start: toClock24(mins),  // "HH:MM" 24h
        _mins: mins
      };
    })
    .filter(Boolean)
    .sort((a, b) => a._mins - b._mins);

  return rows;
}

function buildTodayBlock(rows) {
  // "HH:MM  Title" per line
  return rows.map(r => `${r.start}  ${r.film}`).join("\n");
}

async function fetchFirstWorking() {
  for (const base of IMDB_BASES) {
    try {
      const url = proxify(base);
      const res = await fetch(url, { headers: { "accept-language": "en-GB,en" } });
      if (!res.ok) continue;
      const html = await res.text();
      const rows = parseImdb(html);
      if (rows.length) return { rows, source: base };
    } catch {}
  }
  return { rows: [], source: null };
}

(async () => {
  const now = new Date();
  const nowM = now.getHours() * 60 + now.getMinutes();

  const { rows, source } = await fetchFirstWorking();

  // compute nexts (assume 120 min duration)
  const next_starting = rows.find(r => r._mins > nowM) || null;

  const current = rows
    .map(r => ({ ...r, _end: r._mins + 120 }))
    .filter(r => r._mins <= nowM && r._end > nowM)
    .sort((a, b) => a._end - b._end)[0] || null;

  const next_finishing = current
    ? { film: current.film, screen: null, start: current.start, end: toClock24(current._end) }
    : null;

  const out = {
    generated_at: now.toISOString(),
    source: source || null,
    next_starting: next_starting ? { film: next_starting.film, screen: null, start: next_starting.start, end: null } : null,
    next_finishing,
    today_showings: rows.map(({ film, start }) => ({ film, screen: null, start, end: null })),
    today_block: buildTodayBlock(rows)
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile("public/vue-nottingham.json", JSON.stringify(out, null, 2));
  console.log(`✅ Published vue-nottingham.json with ${rows.length} rows from ${out.source || "n/a"}`);
})();
