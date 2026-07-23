// Transposable notation client. Charts are MusicXML files the owner scanned in
// Soundslice and corrected by hand; the server loads them from its charts/
// folder at boot. Every key is a re-render of that one stored copy, so this
// client only reads — there is no upload path.
//
// Rendering is server-side by design: Verovio's WASM build is several MB, and
// the app deliberately dropped react-pdf for being 1.5 MB while still
// supporting iPadOS 14 Safari. See app/notation.py.
//
// Kept in core as plain fetch so a future native app can reuse it.
import { API_BASE } from "./api";

export interface Transcription {
  id: string;
  tune_id: string;
  book: string;
  printed_page: string;
  source_key: string | null; // concert key the chart is printed in
  verified: boolean; // has a human checked it against the printed page
  model: string | null;
  created_at: string | null;
}

export interface NotationMeta {
  configured: boolean; // is the fake-book reader set up at all
  authed: boolean; // does the caller hold the session cookie
  chart: { book: string; page: string } | null; // which chart this would use
  transcription: Transcription | null; // null = no chart imported for this tune
  keys: string[]; // the 12 targets, spelled for this tune's mode
}

/** Stylesheet for Verovio's music font. The engraved SVG references it by
 *  name rather than inlining 58 KB of base64 font per key, so it must be in
 *  the document or chord-symbol accidentals render as tofu boxes. */
export const NOTATION_FONT_CSS = `${API_BASE}/api/notation/font.css`;

function chartQuery(chart?: { book: string; page: string } | null): string {
  if (!chart) return "";
  return `book=${encodeURIComponent(chart.book)}&page=${encodeURIComponent(chart.page)}`;
}

export async function getNotationMeta(
  tuneId: string,
  chart?: { book: string; page: string } | null,
): Promise<NotationMeta> {
  const q = chartQuery(chart);
  const res = await fetch(`${API_BASE}/api/chart/${tuneId}/notation${q ? `?${q}` : ""}`);
  if (!res.ok) throw new Error(`notation meta ${res.status}`);
  return res.json();
}

/** Tune ids that have a stored chart, so the UI shows "Read in any key" only
 *  where it does something. Charts are loaded from the server's charts/ folder
 *  at boot — there is no upload endpoint — so this is read-only.
 *  Returns an empty set when the reader is locked (401). */
export async function getNotationIndex(): Promise<Set<string>> {
  const res = await fetch(`${API_BASE}/api/notation/tunes`);
  if (!res.ok) return new Set();
  const body = await res.json();
  return new Set<string>(body.tunes ?? []);
}

/** Engraved SVG in `key`. Fetch and inline it — an <img> is an isolated
 *  document and would not see the music font stylesheet. */
export function notationSvgUrl(tuneId: string, key: string, width = 2100): string {
  return `${API_BASE}/api/chart/${tuneId}/notation.svg?key=${encodeURIComponent(key)}&width=${width}`;
}

/** Transposed MusicXML, for opening in MuseScore/Sibelius. */
export function notationMusicXmlUrl(tuneId: string, key: string): string {
  return `${API_BASE}/api/chart/${tuneId}/notation.musicxml?key=${encodeURIComponent(key)}`;
}

/** A render is ~70 ms warm and a few seconds on a cold machine; anything past
 *  this is a request that is never coming back. Without a deadline the UI sat
 *  on "Engraving…" indefinitely — which is precisely what a server-side crash
 *  looked like from the outside, with nothing on screen to say so. */
export const SVG_TIMEOUT_MS = 30_000;

export async function fetchNotationSvg(
  tuneId: string,
  key: string,
  width = 2100,
  signal?: AbortSignal,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SVG_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(notationSvgUrl(tuneId, key, width), { signal: ctrl.signal });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `couldn't engrave this key (${res.status})`);
    }
    return await res.text();
  } catch (e) {
    if ((e as Error).name === "AbortError" && !signal?.aborted) {
      throw new Error("the server didn't come back — try again");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Inject the music font stylesheet once per document. */
let fontLinked = false;
export function ensureNotationFont(): void {
  if (fontLinked || typeof document === "undefined") return;
  fontLinked = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = NOTATION_FONT_CSS;
  document.head.appendChild(link);
}
