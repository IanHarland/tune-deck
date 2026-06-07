// build_seed.mjs — parse an iReal Pro backup HTML export into data/tunes.json
//
// Usage: node scripts/build_seed.mjs [path-to-backup.html]
//
// iReal export format (one <a href="irealb://..."> per playlist):
//   songs joined by literal "==="; the LAST "===" segment is the playlist name.
//   each song: title=composer==style=key==transpose=<obfuscated chords>==0=0
//   field separators are literal "="; only the chord blob's special chars are
//   percent-encoded, so we keep each RAW song segment verbatim to rebuild a
//   single-song deep link, and only decode the leading metadata fields.
//
// See CLAUDE.md ("Data: where tunes come from") for the why.

import fs from 'fs';
import path from 'path';
import os from 'os';
import * as canon from './canon.mjs';

const DEFAULT_BACKUP = path.join(os.homedir(), 'Downloads', 'iReal Pro Backup 6-6-26.html');
const backupPath = process.argv[2] || DEFAULT_BACKUP;
const OUT = path.join(process.cwd(), 'data', 'tunes.json');
const CHARTS_PATH = path.join(process.cwd(), 'data', 'charts.json');

// fake-book chart references (built by scripts/build_charts.py), keyed by
// normalized title. Used both to attach chart locations AND as the primary
// obscurity signal: the more fake books a tune appears in, the more standard it
// is. Missing file -> no chart data, obscurity falls back to playlist frequency.
let charts = {};
try {
  charts = JSON.parse(fs.readFileSync(CHARTS_PATH, 'utf8'));
} catch {
  console.warn('No data/charts.json — run scripts/build_charts.py for chart refs + better obscurity.');
}

// ---------------------------------------------------------------------------
// Canon tiers (scripts/canon.mjs) drive obscurity & difficulty. Matched on
// normalized title (lowercase, alphanumerics only, parentheticals dropped).
// ---------------------------------------------------------------------------
const norm = (t) => (t || '')
  .replace(/\([^)]*\)/g, ' ')      // drop parentheticals
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');      // strip everything but alphanumerics
const toSet = (list) => new Set(list.map(norm));

const CORE_SET = toSet(canon.CORE);
const STANDARD_SET = toSet(canon.STANDARD);
const COMMON_SET = toSet(canon.COMMON);
const VERY_EASY_SET = toSet(canon.VERY_EASY);
const EASY_SET = toSet(canon.EASY);
const ADV_SET = toSet(canon.ADVANCED);
const VERY_HARD_SET = toSet(canon.VERY_HARD);

// mode tags
const BEGINNER_SET = toSet(canon.BEGINNER);
const HARD_SET = toSet([...canon.ADVANCED, ...canon.VERY_HARD]);

// Obscurity: canon membership is the ONLY thing that keeps a tune common.
// Everything else trends to 100 (likely never called), eased a little if it at
// least appears in standard fake books / the owner's playlists.
function obscurityFor(k, bookCount, appearances) {
  if (CORE_SET.has(k)) return 4;
  if (STANDARD_SET.has(k)) return 16;
  if (COMMON_SET.has(k)) return 34;
  return Math.max(60, Math.min(100, 100 - 9 * bookCount - 3 * appearances));
}

function difficultyFor(k) {
  if (VERY_EASY_SET.has(k)) return 10;
  if (EASY_SET.has(k)) return 26;
  if (VERY_HARD_SET.has(k)) return 93;
  if (ADV_SET.has(k)) return 84;
  return 50;
}

// ---------------------------------------------------------------------------
// Style -> feel mapping. Returns null to DROP non-jazz tunes.
// ---------------------------------------------------------------------------
const EXCLUDE = ['pop','rock','country','folk','disco','reggae','soul','funk',
  'rnb',"r'n'b",'hip hop','bluegrass','electro','merengue','smooth'];
const JAZZ_MARKER = ['jazz','swing','bossa','samba','bolero','blues'];

function classify(rawStyle) {
  const s = (rawStyle || '').toLowerCase().trim();
  if (!s) return { feel: 'medium_swing', add: [] }; // untyped library tune
  const has = (...kw) => kw.some((k) => s.includes(k));
  if (has(...EXCLUDE) && !has(...JAZZ_MARKER)) return null; // drop non-jazz
  if (s.includes('waltz')) return { feel: 'waltz', add: [] };
  if (has('bossa','samba','latin','bolero','afro','afox','tango','salsa','mambo',
          'baia','cha','calypso','chacarera','son','even 8','clave','rumba'))
    return { feel: 'latin', add: [] };
  if (has('medium up')) return { feel: 'up', add: ['medium_swing'] };
  if (has('up tempo','up swing','fast','bright') || s === 'up')
    return { feel: 'up', add: [] };
  if (has('ballad','slow')) return { feel: 'ballad', add: [] };
  if (has('swing','blues','shuffle','medium')) return { feel: 'medium_swing', add: [] };
  return { feel: 'medium_swing', add: [] };
}

// "Last First" -> "First Last" (last whitespace token is the first name).
function flipComposer(raw) {
  const c = (raw || '').trim();
  if (!c) return null;
  const parts = c.split(/\s+/);
  if (parts.length === 1) return c;
  const first = parts[parts.length - 1];
  const surname = parts.slice(0, -1).join(' ');
  return `${first} ${surname}`;
}

const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// iReal Pro scrambles the chord data (50-char-segment character swaps). We don't
// want the chords, but the time signature (e.g. "T34" = 3/4) lives in there, and
// a 3/4 tune is a WALTZ regardless of how iReal labelled the style. Algorithm
// from github.com/pianosnake/ireal-reader.
function obfusc50(s) {
  const a = s.split('');
  for (let i = 0; i < 5; i++) { a[49 - i] = s[i]; a[i] = s[49 - i]; }
  for (let i = 10; i < 24; i++) { a[49 - i] = s[i]; a[i] = s[49 - i]; }
  return a.join('');
}
function unscramble(s) {
  let r = '', p;
  while (s.length > 50) {
    p = s.substring(0, 50);
    s = s.substring(50);
    r += s.length < 2 ? p : obfusc50(p);
  }
  return r + s;
}
// Returns "3/4", "4/4", … from a raw song segment, or null.
function timeSignature(rawSeg) {
  const fields = rawSeg.split('=');
  let blob;
  try { blob = decodeURIComponent(fields.slice(6).join('=')); } catch { return null; }
  if (!blob) return null;
  const m = unscramble(blob.replace(/^1r34LbKcu7/, '')).match(/T(\d)(\d)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
const html = fs.readFileSync(backupPath, 'utf8');
const hrefs = [...html.matchAll(/href="(irealb:\/\/[^"]+)"/g)].map((m) => m[1]);

// tune key -> aggregate record
const tunes = new Map();
// count appearances across NAMED playlists only (skip the "BACKUP" superset)
const playlistCount = new Map();

hrefs.forEach((href) => {
  const raw = href.replace('irealb://', '');
  const rawSegments = raw.split('===');
  const playlistName = dec(rawSegments.pop() || '').trim();
  const isBackup = /backup/i.test(playlistName);

  rawSegments.forEach((rawSeg) => {
    if (!rawSeg) return;
    const fields = rawSeg.split('=');
    const title = dec(fields[0] || '').trim();
    if (!title) return;
    const composer = flipComposer(dec(fields[1] || ''));
    const irealStyle = dec(fields[3] || '').trim();
    const key = dec(fields[4] || '').trim();
    const k = norm(title);
    if (!k) return;

    if (!isBackup) {
      const set = playlistCount.get(k) || new Set();
      set.add(playlistName);
      playlistCount.set(k, set);
    }

    if (!tunes.has(k)) {
      // single-song deep link: <rawSegment>===<title> (matches iReal's
      // "songs===playlistName" shape with a one-song playlist).
      const irealUrl = `irealb://${rawSeg}===${encodeURIComponent(title)}`;
      const time = timeSignature(rawSeg);
      tunes.set(k, { title, composer, irealStyle, key, irealUrl, time });
    }
  });
});

// ---------------------------------------------------------------------------
// Build records: classify, score, filter
// ---------------------------------------------------------------------------
const out = [];
let dropped = 0;
for (const [k, t] of tunes) {
  const cls = classify(t.irealStyle);
  if (!cls) { dropped++; continue; }

  const appearances = (playlistCount.get(k)?.size) || 0;
  const chartRefs = charts[k] || [];
  const bookCount = chartRefs.length; // # of fake books that include the tune
  const obscurity = obscurityFor(k, bookCount, appearances);
  const difficulty = difficultyFor(k);

  // SYSTEMIC waltz detection: a 3/4 tune is a waltz, whatever iReal called it.
  const inThree = t.time && t.time.startsWith('3/');
  const feel = inThree ? 'waltz' : cls.feel;
  const additional = inThree ? [] : cls.add;

  // mode tags (beginner = most-called 50; hard = common-but-difficult)
  const tags = [];
  if (BEGINNER_SET.has(k)) tags.push('beginner');
  if (HARD_SET.has(k)) tags.push('hard');

  out.push({
    title: t.title,
    composer: t.composer,
    original_key: t.key || null,
    feel,
    additional_feels: additional,
    ireal_style: t.irealStyle || null,
    ireal_url: t.irealUrl,
    charts: chartRefs,
    time_signature: t.time || null,
    tags,
    obscurity_score: obscurity,
    difficulty_score: difficulty,
  });
}

// manual additions not in the iReal library (e.g. for Smalls mode)
for (const extra of canon.MANUAL_TUNES) {
  if (out.some((o) => norm(o.title) === norm(extra.title))) continue;
  out.push({
    alternate_titles: [],
    additional_feels: [],
    ireal_style: null, ireal_url: null, charts: [], time_signature: null,
    tags: [], obscurity_score: 30, difficulty_score: 50,
    ...extra,
  });
}

out.sort((a, b) => a.title.localeCompare(b.title));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const byFeel = {};
for (const t of out) byFeel[t.feel] = (byFeel[t.feel] || 0) + 1;
console.log(`Parsed ${tunes.size} unique tunes; kept ${out.length}, dropped ${dropped} (non-jazz).`);
console.log('Feel distribution:', byFeel);
const canonCount = out.filter((t) => t.obscurity_score < 45).length;
console.log(`Canon (obscurity <45): ${canonCount}; ` +
  `core(<=4): ${out.filter((t)=>t.obscurity_score<=4).length}, ` +
  `at 100 (never called): ${out.filter((t)=>t.obscurity_score===100).length}.`);
console.log(`Wrote ${OUT}`);
