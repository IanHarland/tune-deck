// Extract iReal Pro deep links for MANUAL_TUNES from a supplemental pack export
// (e.g. a forum "Jazz 1460" collection) so those cards can open in iReal Pro.
//
// The owner's backup is still the primary library; this only fills in deep links
// for the hand-added tunes that the backup didn't include. Writes a small,
// committed data/manual_ireal.json (keyed by the manual tune's normalized title)
// that build_seed.mjs merges in — so the build stays reproducible without the
// pack HTML present.
//
//   node scripts/extract_manual_ireal.mjs ["~/Downloads/Jazz 1460.html"]
import fs from "fs";
import os from "os";
import path from "path";
import * as canon from "./canon.mjs";

const SRC = (process.argv[2] || path.join(os.homedir(), "Downloads", "Jazz 1460.html"))
  .replace(/^~/, os.homedir());
const OUT = path.join(process.cwd(), "data", "manual_ireal.json");

const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
// build_seed's norm (drop parentheticals, alphanumeric-lower) — for the OUTPUT key
const norm = (t) => (t || "").replace(/\([^)]*\)/g, " ").toLowerCase().replace(/[^a-z0-9]/g, "");
// article-aware norm (for matching "The Sidewinder" to pack's "Sidewinder")
const norm2 = (t) => {
  let s = (t || "").toLowerCase();
  s = s.replace(/^(the|a|an)\s+/, "").replace(/,\s*(the|a|an)$/, "");
  return s.replace(/[^a-z0-9]/g, "");
};

if (!fs.existsSync(SRC)) {
  console.error(`No pack at ${SRC} — pass the path as an argument.`);
  process.exit(1);
}

const html = fs.readFileSync(SRC, "utf8");
const hrefs = [...html.matchAll(/href="(irealb:\/\/[^"]+)"/g)].map((m) => m[1]);

const pack = new Map(); // norm2(title) -> { title, key, ireal_url }
for (const href of hrefs) {
  const segs = href.replace("irealb://", "").split("===");
  segs.pop(); // playlist name
  for (const seg of segs) {
    if (!seg) continue;
    const fields = seg.split("=");
    const title = dec(fields[0] || "").trim();
    if (!title) continue;
    const k = norm2(title);
    if (pack.has(k)) continue;
    pack.set(k, {
      title,
      key: dec(fields[4] || "").trim() || null,
      ireal_url: `irealb://${seg}===${encodeURIComponent(title)}`,
    });
  }
}

const result = {};
const hits = [], misses = [];
for (const m of canon.MANUAL_TUNES) {
  const found = pack.get(norm2(m.title));
  if (found) {
    result[norm(m.title)] = { ireal_url: found.ireal_url, key: found.key, pack_title: found.title };
    hits.push(`${m.title} → "${found.title}" (${found.key})`);
  } else {
    misses.push(m.title);
  }
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(`Pack: ${pack.size} unique titles from ${path.basename(SRC)}`);
console.log(`Matched ${hits.length}/${canon.MANUAL_TUNES.length} manual tunes:`);
hits.forEach((h) => console.log(`  ✓ ${h}`));
console.log(`Still link-less (${misses.length}): ${misses.join(", ")}`);
console.log(`Wrote ${OUT}`);
