// scrape.mjs — Vue Nottingham -> JSON for Widgy
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
  const page = await browser.newPage({ locale: "en-GB" });

  await page.goto(VUE_URL, { waitUntil: "domcontentloaded" });

  // Try to prod the page to render “All Times”
  // If a button exists, click it. Ignore errors if not found.
  try {
    await page.getByText(/All Times|Today|Show all/i).first().click({ timeout: 3000 });
  } catch {}

  // Wait for common showtime markers (very tolerant)
  const candidates = [
    "[data-qa='showtime']",
    "button[aria-label*='Showtime']",
    "text=Screen",
    "text::has(:text-matches('^\\d{1,2}:\\d{2}$'))" // Playwright text engine
  ];
  let loaded = false;
  for (const sel of candidates) {
    try {
      await page.waitForSelector(sel, { timeout: 7000 });
      loaded = true;
      break;
    } catch {}
  }
  if (!loaded) {
    // one last wait – sometimes hydration is slow on CI
    await page.waitForTimeout(6000);
  }

  // Save raw HTML so we can inspect what CI saw if parsing is empty
  const raw = await page.content();
  await fs.mkdir("public", { recursive: true });
  await fs.writeFile("public/raw.html", raw);

  // Try structured selectors first; then fall back to text sweep
  let data = await page.evaluate(() => {
    const out = [];
    // Try a data-qa based structure
    const cards = document.querySelectorAll("[data-qa*='movie'],[data-qa*='film'],article,section");
    cards.forEach(card => {
      const title =
        card.querySelector("[data-qa='movie-title'],[data-qa='film-title'],h2,h3")?.textContent?.trim();
      if (!title || title.length < 2) return;

      const screenMatch = (card.innerText.match(/\bScreen\s+([A-Za-z0-9]+)\b/i) || [])[1] || null;

      const times = Array.from(
        card.querySelectorAll("[data-qa='showtime'], time, button, a")
      )
        .map(el => (el.textContent || "").trim())
        .filter(t => /^\d{1,2}:\d{2}$/.test(t));

      times.forEach(t => out.push({ film: title, screen: screenMatch, start: t, end: null }));
    });
    return out;
  });

  // Fallback: text-only sweep if selectors didn’t work
  if (!data || data.length === 0) {
    const bodyText = await page.evaluate(() => document.body.innerText);
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
        data.push({ film: lastTitle, screen, start: times[0], end: times[1] });
      } else {
        data.push({ film: lastTitle, screen, start: times[0], end: null });
      }
    }
  }

  await browser.close();

  today_showings = (data || [])
    .filter(s => /^\d{1,2}:\d{2}$/.test(s.start))
    .sort((a, b) => toMins(a.start) - toMins(b.start));

  // Compute next-starting / next-finishing
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
    next_starting,
    next_finishing,
    today_showings,
  };

  await fs.writeFile("public/vue-nottingham.json", JSON.stringify(out, null, 2));
  console.log(`✅ Scraped ${today_showings.length} showings and wrote public/vue-nottingham.json`);
})();
