// Portable key helpers. The server is the source of truth for the *persisted*
// randomized key; this mirrors the same logic for any client-side display/use.
//
// A tune is randomized within its own mode. Enharmonic spelling follows the
// conventional key signature per mode: major uses Db/Gb/Ab, minor uses C#/F#/G#
// (no "Db minor" — it's C# minor). See app/web.py for the authoritative copy.

export const MAJOR_KEYS = [
  "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
] as const;
export const MINOR_KEYS = [
  "C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B",
] as const;

export function isMinor(key: string | null | undefined): boolean {
  if (!key) return false;
  const k = key.trim().toLowerCase();
  return k.endsWith("-") || k.endsWith("m") || k.includes("min");
}

export function randomKeyInMode(originalKey: string | null | undefined): string {
  if (isMinor(originalKey)) {
    return `${MINOR_KEYS[Math.floor(Math.random() * MINOR_KEYS.length)]}-`;
  }
  return MAJOR_KEYS[Math.floor(Math.random() * MAJOR_KEYS.length)];
}

// --- Key signature → playing card -------------------------------------- //
// A key's number of sharps/flats is the card's RANK; sharps are RED, flats are
// BLACK. Suit also encodes mode: sharp major=♥, sharp minor=♦, flat major=♠,
// flat minor=♣ (so A major = 3 sharps = 3♥, Bb major = 2 flats = 2♠). C major /
// A minor have no accidentals → no suit.

export type Suit = "heart" | "diamond" | "spade" | "club";
export interface KeyCard {
  count: number; // number of accidentals (0–7)
  suit: Suit | null;
  color: "red" | "black" | null;
}

// circle of fifths, index = number of accidentals
const MAJOR_SHARP = ["C", "G", "D", "A", "E", "B", "F#", "C#"];
const MAJOR_FLAT = ["C", "F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"];
const MINOR_SHARP = ["A", "E", "B", "F#", "C#", "G#", "D#", "A#"];
const MINOR_FLAT = ["A", "D", "G", "C", "F", "Bb", "Eb", "Ab"];
const ENHARMONIC: Record<string, string> = {
  "D#": "Eb", "G#": "Ab", "A#": "Bb", "E#": "F", "B#": "C", "Fb": "E", "Cb": "B",
};

export function keyCard(key: string | null | undefined): KeyCard {
  const none: KeyCard = { count: 0, suit: null, color: null };
  if (!key) return none;
  const m = key.match(/^([A-Ga-g])([b#]?)/);
  if (!m) return none;
  const root = m[1].toUpperCase() + (m[2] || "");
  const minor = isMinor(key);
  const sharps = minor ? MINOR_SHARP : MAJOR_SHARP;
  const flats = minor ? MINOR_FLAT : MAJOR_FLAT;

  const lookup = (r: string): { count: number; acc: "sharp" | "flat" } | null => {
    const s = sharps.indexOf(r);
    if (s > 0) return { count: s, acc: "sharp" };
    const f = flats.indexOf(r);
    if (f > 0) return { count: f, acc: "flat" };
    return null; // index 0 (C/A) or not found
  };

  // exact 0-accidental keys
  if (sharps[0] === root) return none;
  const res = lookup(root) ?? lookup(ENHARMONIC[root] ?? root);
  if (!res) return none;

  const color = res.acc === "sharp" ? "red" : "black";
  const suit: Suit =
    res.acc === "sharp" ? (minor ? "diamond" : "heart") : (minor ? "club" : "spade");
  return { count: res.count, suit, color };
}

// --- Instrument transposition -------------------------------------------- //
// Keys are STORED in concert pitch and transposed only for display, so the DB
// stays instrument-agnostic. A transposing instrument's WRITTEN key = concert
// key + offset semitones (e.g. a Bb instrument reads a whole step up).

export interface Instrument {
  id: string;
  label: string;
  offset: number; // semitones added to concert to get written pitch
}

export const INSTRUMENTS: Instrument[] = [
  { id: "C", label: "C", offset: 0 }, // piano, guitar, bass, flute, voice…
  { id: "Bb", label: "B♭", offset: 2 }, // tenor/soprano sax, trumpet, clarinet
  { id: "Eb", label: "E♭", offset: 9 }, // alto/bari sax
  { id: "F", label: "F", offset: 7 }, // french horn
];

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Transpose a key string (e.g. "Bb", "C#", "Eb-") by `semitones`, keeping the
 * mode and using the conventional enharmonic spelling for the result. */
export function transposeKey(
  key: string | null | undefined,
  semitones: number,
): string | null {
  if (!key) return null;
  if (!semitones) return key;
  const m = key.match(/^([A-Ga-g])([b#]?)(.*)$/);
  if (!m) return key;
  const [, letter, acc] = m;
  let pc = LETTER_PC[letter.toUpperCase()];
  if (pc === undefined) return key;
  if (acc === "#") pc += 1;
  else if (acc === "b") pc -= 1;
  pc = ((pc + semitones) % 12 + 12) % 12;
  const minor = isMinor(key);
  const root = (minor ? MINOR_KEYS : MAJOR_KEYS)[pc];
  return minor ? `${root}-` : root;
}

/** Display a minor key as its RELATIVE MAJOR (root up a minor third), e.g.
 * "A-" → "C", "G-" → "Bb". Major keys pass through unchanged. */
export function toRelativeMajor(key: string | null | undefined): string | null {
  if (!key) return key ?? null;
  if (!isMinor(key)) return key;
  const m = key.match(/^([A-Ga-g])([b#]?)/);
  if (!m) return key;
  let pc = LETTER_PC[m[1].toUpperCase()];
  if (pc === undefined) return key;
  if (m[2] === "#") pc += 1;
  else if (m[2] === "b") pc -= 1;
  return MAJOR_KEYS[((pc + 3) % 12 + 12) % 12];
}
