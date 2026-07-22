// Transposable notation client. A chart is transcribed from the owner's
// fake-book scan once (server-side vision call), cached as MusicXML, then
// transposed + engraved on demand — so all 12 keys come from one transcription.
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
  verified: boolean; // has a human checked it against the source page
  model: string | null;
  created_at: string | null;
}

export interface NotationMeta {
  configured: boolean; // is the fake-book reader set up at all
  authed: boolean; // does the caller hold the session cookie
  chart: { book: string; page: string } | null; // which chart this would use
  transcription: Transcription | null; // null = not transcribed yet
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

/** Transcribe the chart and cache it. Slow — a vision call over the page
 *  images — so callers should show progress. Throws "unauthorized" (401) or
 *  "no-chart" (404) for the UI to branch on. */
export async function transcribeChart(
  tuneId: string,
  chart?: { book: string; page: string } | null,
): Promise<{ transcription: Transcription; cached: boolean }> {
  const q = chartQuery(chart);
  const res = await fetch(`${API_BASE}/api/chart/${tuneId}/notation${q ? `?${q}` : ""}`, {
    method: "POST",
  });
  if (res.status === 401) throw new Error("unauthorized");
  if (res.status === 404) throw new Error("no-chart");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `transcribe ${res.status}`);
  }
  return res.json();
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

export async function fetchNotationSvg(
  tuneId: string,
  key: string,
  width = 2100,
): Promise<string> {
  const res = await fetch(notationSvgUrl(tuneId, key, width));
  if (!res.ok) throw new Error(`notation svg ${res.status}`);
  return res.text();
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
