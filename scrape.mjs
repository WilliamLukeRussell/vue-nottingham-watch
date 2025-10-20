// scrape.mjs — fetch Vue Nottingham via ScrapingBee (bypasses Cloudflare) and publish JSON
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio"; // we'll install cheerio in the workflow

const API_KEY = process.env.SCRAPINGBEE_KEY || "";
const VUE_URL = "https://www.myvue.com/cinema/nottingham/whats-on";

function toMins(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return 1e9;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

async function fetchRendered(url) {
  if (!API_KEY) throw new Error("Missing SCRAPINGBEE_KEY secret");
  const api = new URL("https://app.scrapingbee.com/api/v1");
  api.searchParams.set("api_key", API_KEY);
  api.searchParams.set("url", url);
  api.searchParams.set("render_js", "true");
  api.searchParams.set("country_code", "gb");
  api.searchParams.set("block_resources", "false");

  const res = await fetch(api, { headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`ScrapingBee HTTP ${res.status}`);
  return await res.text();
}

(async () => {
  const now = new Date();
  let today_showings = [];
  let error = null;

  try {
    const html = await fetchRendered(VUE_URL);

    // Save raw for debugging
    await fs.mkdir("public", { recursive: true });
    await fs.writeFile("public/raw.html", html);

    const $ = cheerio.load(html);

    // Try structured selectors first (tweak as Vue updates DOM)
    // Titles
    const cards = $("[data-qa*='movie'],[data-qa*='film'],article,section");
    const data = [];

    cards.each((_, el) => {
      const $el = $(el);
      const title =
        $el.find("[data-qa='movie-title'],[data-qa='film-title'],h2,h3")
          .first()
          .text()
          .trim();
      if (!title || title.length < 2) return;

      const screenMatch = $el.text().match(/\bScreen\s+([A-Za-z0-9]+)\b/i);
      const screen = screenMatch ? screenMatch[1] : null;

      // find any child node that looks like "HH:MM"
      $el.find("*").each((__, node) => {
        const t = $(node).text().trim();
        if (/^\d{1,2}:\d{2}$/.test(t)) {
          data.push({ film: title, screen, start: t, end: null });
        }
      });
    });

    // Fallback: text sweep if structured selectors miss
    let results = data;
    if (results.length === 0) {
      const bodyText = $("body").text();
      const lines = bodyText.split(/\n+/).map(s => s.trim()).filter(Boolean);

      let lastTitle = null;
      for (const line of lines) {
        const looksLikeTitle =
          /[A-Za-z]/.test(line) &&
          !/\bScreen\b/i.test(line) &&
          !/^\d{1,2}:\d{2}(\s+\d{1,2}:\d{2})?$/.test(line);
        if (looksLikeTitle) lastTitle = line;

        const times = Array.from(line.matchAll(/\b(\d{1,2}:\d{2})\b/g)).map(m => m[1]);
        if (!times.length || !lastTitle) continue;

        const screenMatch = line.match(/\bScreen\s+([A-Za-z0-9]+)\b/i);
        const screen = screenMatch ? screenMatch[1] : null;

        if (times.length >= 2) {
          results.push({ film: lastTitle, screen, start: times[0], end: times[1] });
        } else {
          results.push({ film: lastTitle, screen, start: times[0], end: null });
        }
      }
    }

    // Normalize & sort
    today_showings = results
      .filter(s => /^\d{1,2}:\d{2}$/.test(s.start))
      .sort((a, b) => toMins(a.start) - toMins(b.start));

  } catch (e) {
    error = String(e?.message || e);
    console.error("Scrape error:", error);
  }

  // Compute nexts (assume 120m if end unknown)
  const nowM = now.getHours() * 60 + now.getMinutes();
  const next_starting = today_showings.find(s => toMins(s.start) > nowM) || null;

  const withEnds = today_showings.map(s => ({
    ...s,
    _startM: toMins(s.start),
    _endM: s.end ? toMins(s.end) : toMins(s.start) + 120,
  }));
  const current = withEnds
    .filter(s => s._startM <= nowM && s._endM > nowM)
    .sort((a, b) => a._endM - b._endM)[0] || null;

  const pad = n => String(n).padStart(2, "0");
  const fmt = m => `${pad(Math.floor(m/60))}:${pad(m%60)}`;
  const next_finishing = current
    ? { film: current.film, screen: current.screen, start: fmt(current._startM), end: fmt(current._endM) }
    : null;

  const out = {
    generated_at: now.toISOString(),
    ...(error ? { error } : {}),
    next_starting,
    next_finishing,
    today_showings,
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile(path.join("public", "vue-nottingham.json"), JSON.stringify(out, null, 2));
  console.log(`✅ Published vue-nottingham.json with ${today_showings.length} showings`);
})();
