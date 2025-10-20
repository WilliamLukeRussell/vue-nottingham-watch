// Writes JSON to public/vue-nottingham.json so Pages can serve it
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
    await page.waitForTimeout(3000);

    // Very tolerant text scrape
    const txt = await page.evaluate(() => document.body.innerText);
    const lines = txt.split(/\n+/).map(s => s.trim()).filter(Boolean);

    let lastTitle = null;
    for (const line of lines) {
      const looksLikeTitle =
        /[A-Za-z]/.test(line) &&
        !/\bScreen\b/i.test(line) &&
        !/^\d{1,2}:\d{2}(\s+\d{1,2}:\d{2})?$/.test(line);
      if (looksLikeTitle) lastTitle = line;

      const times = Array.from(line.matchAll(/\b(\d{1,2}:\d{2})\b/g)).map(m => m[1]);
      if (!times.length) continue;

      const screenMatch = line.match(/\bScreen\s+([A-Za-z0-9]+)\b/i);
      const screen = screenMatch ? (/^\d+$/.test(screenMatch[1]) ? Number(screenMatch[1]) : screenMatch[1]) : null;

      if (lastTitle) {
        if (times.length >= 2) today_showings.push({ film: lastTitle, screen, start: times[0], end: times[1] });
        else today_showings.push({ film: lastTitle, screen, start: times[0], end: null });
      }
    }

    today_showings = today_showings
      .filter(s => /^\d{1,2}:\d{2}$/.test(s.start))
      .sort((a, b) => toM(a.start) - toM(b.start));

    await browser.close();
  } catch (e) {
    console.error("Scrape error:", e.message);
  }

  const nowM = now.getHours() * 60 + now.getMinutes();
  const next_starting = today_showings.find(s => toM(s.start) > nowM) || null;

  const withEnds = today_showings.map(s => ({
    ...s,
    _startM: toM(s.start),
    _endM: s.end ? toM(s.end) : toM(s.start) + 120,
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
    next_starting,
    next_finishing,
    today_showings,
  };

  await fs.mkdir("public", { recursive: true });
  await fs.writeFile(path.join("public", "vue-nottingham.json"), JSON.stringify(out, null, 2));
  console.log("✅ Wrote public/vue-nottingham.json");
})();
