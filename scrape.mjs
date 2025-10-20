// scrape.mjs — robust + debuggable Vue Nottingham scraper for GitHub Pages
import fs from "node:fs/promises";
import { chromium } from "playwright";

const VUE_URL = "https://www.myvue.com/cinema/nottingham/whats-on";

const toMins = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return 1e9;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
};

async function safeWritePublic(name, contents) {
  await fs.mkdir("public", { recursive: true });
  await fs.writeFile(`public/${name}`, contents);
}

(async () => {
  const now = new Date();
  let today_showings = [];
  let next_starting = null;
  let next_finishing = null;

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage({ locale: "en-GB" });

  try {
    // Go to Vue Nottingham
    await page.goto(VUE_URL, { waitUntil: "domcontentloaded" });

    // Try to accept cookies if a banner exists
    const cookieButtons = [
      'button:has-text("Accept All")',
      'button:has-text("Accept all")',
      'button:has-text("I Accept")',
      'button:has-text("Agree")',
      '[aria-label*="Accept"]',
    ];
    for (const sel of cookieButtons) {
      try {
        const b = page.locator(sel).first();
        if (await b.count()) { await b.click({ timeout: 1500 }); break; }
      } catch {}
    }

    // If there’s a “Today / All Times / Show all” toggle, try clicking it
    const toggles = [/All Times/i, /Today/i, /Show all/i];
    for (const re of toggles) {
      try {
        const btn = page.getByText(re).first();
        if (await btn.count()) { await btn.click({ timeout: 1500 }); }
      } catch {}
    }

    // Wait for any signs of showtimes to render
    const waitSelectors = [
      "[data-qa='showtime']",
      "time",
      "button:has-text(':')",
      "a:has-text(':')",
      "text=Screen",
    ];
    let loaded = false;
    for (const sel of waitSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 8000 });
        loaded = true; break;
      } catch {}
    }
    if (!loaded) await page.waitForTimeout(6000);

    // Save a raw snapshot for debugging
    await safeWritePublic("raw.html", await page.content());
    await page.screenshot({ path: "public/snap.png", fullPage: true });

    // Strategy A: structured selectors on typical Vue markup
    let data = await page.evaluate(() => {
      const out = [];
      // Try to find film cards/sections
      const cards = document.querySelectorAll("[data-qa*='movie'], [data-qa*='film'], article, section");
      cards.forEach(card => {
        const title =
          card.querySelector("[data-qa='movie-title'], [data-qa='film-title'], h2, h3")
            ?.textContent?.trim();
        if (!title || title.length < 2) return;

        // Screen text (if present anywhere within the card)
        const screenMatch = (card.innerText.match(/\bScreen\s+([A-Za-z0-9]+)\b/i) || [])[1] || null;

        // Times (try elements likely to contain HH:MM)
        const timeNodes = card.querySelectorAll("[data-qa='showtime'], time, button, a, span, div");
        timeNodes.forEach(el => {
          const t = (el.textContent || "").trim();
          if (/^\d{1,2}:\d{2}$/.test(t)) out.push({ film: title, screen: screenMatch, start: t, end: null });
        });
      });
      return out;
    });

    // Strategy B: text sweep fallback
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
          (data ||= []).push({ film: lastTitle, screen, start: times[0], end: times[1] });
        } else {
          (data ||= []).push({ film: lastTitle, screen, start: times[0], end: null });
        }
      }
    }

    // Build final payload
    const sorted = (data || [])
      .filter(s => /^\d{1,2}:\d{2}$/.test(s.start))
      .sort((a, b) => toMins(a.start) - toMins(b.start));

    const nowM = now.getHours() * 60 + now.getMinutes();
    today_showings = sorted;
    const next = sorted.find(s => toMins(s.start) > nowM) || null;

    const withEnds = sorted.map(s => ({
      ...s,
      _startM: toMins(s.start),
      _endM: s.end ? toMins(s.end) : toMins(s.start) + 120,
    }));
    const current = withEnds
      .filter(s => s._startM <= nowM && s._endM > nowM)
      .sort((a, b) => a._endM - b._endM)[0] || null;

    const pad = n => String(n).padStart(2, "0");
    const fmt = m => `${pad(Math.floor(m/60))}:${pad(m%60)}`;

    next_starting = next || null;
    next_finishing = current
      ? { film: current.film, screen: current.screen, start: fmt(current._startM), end: fmt(current._endM) }
      : null;

  } catch (err) {
    console.error("Scrape error:", err?.message || err);
  } finally {
    await browser.close();
  }

  const out = {
    generated_at: now.toISOString(),
    next_starting,
    next_finishing,
    today_showings,
  };

  await safeWritePublic("vue-nottingham.json", JSON.stringify(out, null, 2));
  console.log(`✅ Published vue-nottingham.json with ${today_showings.length} showings`);
})();
