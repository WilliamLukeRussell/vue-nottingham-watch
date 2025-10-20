// scrape.mjs — scrapes Vue Nottingham showtimes & outputs vue-nottingham.json
import fs from "fs/promises";
import path from "path";
import playwright from "playwright";

const url = "https://www.myvue.com/cinema/nottingham/whats-on";

async function main() {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle" });

  const data = await page.evaluate(() => {
    const films = Array.from(document.querySelectorAll(".movie")).map(movie => {
      const title = movie.querySelector(".movie-title")?.textContent?.trim();
      const screen = movie.querySelector(".movie-screen")?.textContent?.trim() || null;
      const times = Array.from(movie.querySelectorAll(".show-time")).map(t =>
        t.textContent.trim()
      );
      return { film: title, screen, times };
    });
    return films.filter(f => f.film);
  });

  const now = new Date();
  const flatTimes = [];
  data.forEach(f => {
    f.times.forEach(t => flatTimes.push({ film: f.film, screen: f.screen, start: t }));
  });

  const toM = t => {
    const m = t.match(/(\d+):(\d+)/);
    if (!m) return 9999;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };
  flatTimes.sort((a, b) => toM(a.start) - toM(b.start));

  const nowM = now.getHours() * 60 + now.getMinutes();
  const next = flatTimes.find(s => toM(s.start) > nowM) || null;
  const current = flatTimes.find(s => toM(s.start) <= nowM && toM(s.start) + 120 > nowM) || null;

  const result = {
    generated_at: now.toISOString(),
    next_starting: next,
    next_finishing: current
      ? { film: current.film, screen: current.screen, end: `${(toM(current.start) + 120) / 60}:00` }
      : null,
    today_showings: flatTimes
  };

  return result;
}

main()
  .then(async data => {
    await fs.writeFile("vue-nottingham.json", JSON.stringify(data, null, 2));
    console.log("✅ vue-nottingham.json updated");
    process.exit(0);
  })
  .catch(err => {
    console.error("Error:", err);
    process.exit(1);
  });
