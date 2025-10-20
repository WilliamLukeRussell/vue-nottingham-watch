// scrape.mjs  – quick sanity test
import fs from "node:fs/promises";

await fs.mkdir("public", { recursive: true });
await fs.writeFile(
  "public/vue-nottingham.json",
  JSON.stringify({ ok: true, time: new Date().toISOString() }, null, 2)
);

console.log("✅ wrote public/vue-nottingham.json");
