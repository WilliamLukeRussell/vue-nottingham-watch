// Minimal scraper that ALWAYS publishes a file to /public/vue-nottingham.json
// (Even if parsing fails, Widgy gets a valid JSON URL.)
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const VUE_URL = "https://www.myvue.com/cinema/nottingham/whats-on";

const toM = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return 1e9;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
};

(async () => {
  const now = new Date();
  let today_showings = [];

  try {
    const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage({ locale: "en-GB" });
    await page.goto(VUE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000); // give the page a moment

    // Grab all visible text and do a tolerant parse for:
    // "HH:MM HH:MM ... Screen X ... <Film Title>"
    const txt = await page.evaluate(() => document.body.innerText);
    const lines = txt.split(/\n+/).map((s) => s.trim()).filter(Boolean);

    // naive sweep: collect times + a nearby "Screen" + last seen title-ish line
    let lastTitle = null;
    for (const line of lines) {
      // title heuristic: long-ish line without "Screen" that isn't just times
      const looksLikeTitle = /[A-Za-z]/.test(line) && !/\bScreen\b/i.test(line) && !/^\d{1,2}:\d{2}(\s+\d{1,2}:\d{2})?$/.test(line);
      if (looksLikeTitle) lastTitle = line;

      // find time pairs or single time on lines with Screen
      const times = Array.from(line.matchAll(/\b(\d{1,2}:\d{2})\b/g)).map((m) => m[1]);
      if (!times.length) continue;

      // look for screen mention in this or adjacent lines
      const screenMatch = line.match(/\bScreen\s+([A-Za-z0-9]+)\b/i);
      const screen = screenMatch ? ( /^\d+$/.test(screenMatch[1]) ? Number(screenMatch[1]) : screenMatch[1] ) : null;

      // build entries (if there are two times, treat as start/end)
      if (lastTitle) {
        if (times.length >= 2) {
          today_showings.push({ film: lastTitle, screen, start: times[0], end: times[1] });
        } else {
          today_showings.push({ film: lastTitle, screen, start: times[0], end: null });
        }
      }
    }

    // sort by start
    today_showings = today_showings
      .filter((s) => /^\d{1,2}:\d{2}$/.test(s.start))
      .sort((a, b) => toM(a.start) - toM(b.start));

    await browser.close();
  } catch (e) {
    // fall through with empty today_showings; we still publish a file
    console.error("Scrape error (publishing placeholder):", e.message);
  }

  // compute next_starting / next_finishing (assume 120m if end missing)
  const nowM = now.getHours() * 60 + now.getMinutes();
  const next_starting = today_showings.find((s) => toM(s.start) > nowM) || null;

  const withEnds = today_showings.map((s) => ({
    ...s,
    _startM: toM(s.start),
    _endM: s.end ? toM(s.end) : toM(s.start) + 120,
  }));
  const current = withEnds
    .filter((s) => s._startM <= nowM && s._endM > nowM)
    .sort((a, b) => a._endM - b._endM)[0] || null;

  const next_finishing = current
    ? { film: current.film, screen: current.screen, start: `${String(Math.floor(current._startM/60)).padStart(2,"0")}:${String(current._startM%60).padStart(2,"0")}`, end: `${String(Math.floor(current._endM/60)).padStart(2,"0")}:${String(current._endM%60).padStart(2,"0")}` }
    : null;

  const out = {
    generated_at: now.toISOString(),
    next_starting,
    next_finishing,
    today_showings,
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile(path.join("public", "vue-nottingham.json"), JSON.stringify(out, null, 2));
  console.log("✅ Wrote public/vue-nottingham.json");
})();
