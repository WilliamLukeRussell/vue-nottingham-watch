// scrape.mjs — updated to correctly wait for Vue showtimes to load
import fs from "node:fs/promises";
import { chromium } from "playwright";

const VUE_URL = "https://www.myvue.com/cinema/nottingham/whats-on";

const toMins = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return 1e9;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
};

(async () => {
  const now = new Date();
  let today_showings = [];

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.goto(VUE_URL, { waitUntil: "domcontentloaded" });

  // Wait until Vue’s showtimes container appears
  await page.waitForTimeout(8000);

  // Grab film titles and showtimes directly from the rendered elements
  const data = await page.evaluate(() => {
    const films = [];
    document.querySelectorAll("[data-qa='movie-title']").forEach((el) => {
      const film = el.textContent.trim();
      const container = el.closest("[data-qa='movie-card']") || el.parentElement;
      const times = Array.from(container.querySelectorAll("[data-qa='showtime']"))
        .map((t) => t.textContent.trim())
        .filter(Boolean);
      const screenMatch = container.innerText.match(/\bScreen\s+([A-Za-z0-9]+)\b/i);
      const screen = screenMatch ? screenMatch[1] : null;
      times.forEach((start) => {
        films.push({ film, screen, start, end: null });
      });
    });
    return films;
  });

  await browser.close();

  today_showings = data.sort((a, b) => toMins(a.start) - toMins(b.start));

  // Compute next starting and finishing
  const nowM = now.getHours() * 60 + now.getMinutes();
  const next_starting = today_showings.find((s) => toMins(s.start) > nowM) || null;

  const withEnds = today_showings.map((s) => ({
    ...s,
    _startM: toMins(s.start),
    _endM: s.end ? toMins(s.end) : toMins(s.start) + 120,
  }));
  const current = withEnds
    .filter((s) => s._startM <= nowM && s._endM > nowM)
    .sort((a, b) => a._endM - b._endM)[0] || null;

  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

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
  await fs.writeFile("public/vue-nottingham.json", JSON.stringify(out, null, 2));
  console.log(`✅ Scraped ${today_showings.length} showings and wrote vue-nottingham.json`);
})();
