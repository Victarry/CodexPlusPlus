/** Build release summaries without fetching any third-party promotional data. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "site/data");
mkdirSync(outDir, { recursive: true });

function buildReleases() {
  const raw = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const blocks = raw.split(/^## /m).slice(1);
  const releases = [];
  for (const block of blocks.slice(0, 4)) {
    const headerEnd = block.indexOf("\n");
    const header = block.slice(0, headerEnd).trim(); // 如 1.7.7 - 2026-10-13
    const m = header.match(/^([\w.+-]+)\s*-\s*(.+)$/);
    if (!m) continue;
    const items = block
      .slice(headerEnd + 1)
      .split(/^- /m)
      .slice(1)
      .map((item) => item.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 5)
      .map((text) => (text.length > 140 ? text.slice(0, 137) + "…" : text));
    releases.push({ version: m[1], date: m[2].trim(), items });
  }
  writeFileSync(join(outDir, "releases.json"), JSON.stringify({ generated_at: new Date().toISOString(), releases }, null, 2));
  console.log(`releases.json: ${releases.length} versions (${releases.map((r) => r.version).join(", ")})`);
}

buildReleases();
