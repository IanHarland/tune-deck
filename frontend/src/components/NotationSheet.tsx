import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureNotationFont,
  fetchNotationSvg,
  getNotationMeta,
  notationMusicXmlUrl,
  transcribeChart,
  type NotationMeta,
} from "../core/notation";
import type { Tune } from "../core/types";

// The chart from the owner's fake book, re-engraved in any key. The scan is
// transcribed to MusicXML once (server-side vision call — slow and costs money,
// hence the explicit button), then every key is a cheap re-render of that one
// transcription.
export default function NotationSheet({
  tune,
  currentKey,
  onClose,
}: {
  tune: Tune;
  currentKey: string | null;
  onClose: () => void;
}) {
  const [meta, setMeta] = useState<NotationMeta | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureNotationFont();
  }, []);

  // Load status for this tune's chart.
  useEffect(() => {
    let live = true;
    setMeta(null);
    setSvg(null);
    setError(null);
    getNotationMeta(tune.id)
      .then((m) => {
        if (!live) return;
        setMeta(m);
        // Prefer the key already on screen, so the sheet matches the card.
        const wanted = currentKey && m.keys.includes(stripMode(currentKey))
          ? stripMode(currentKey)
          : stripMode(m.transcription?.source_key ?? tune.original_key ?? "C");
        setKey(wanted);
      })
      .catch((e) => live && setError(String(e.message || e)));
    return () => {
      live = false;
    };
  }, [tune.id, currentKey, tune.original_key]);

  // Re-engrave whenever the target key changes.
  useEffect(() => {
    if (!meta?.transcription || !key) return;
    let live = true;
    setBusy(true);
    const width = Math.round((wrap.current?.clientWidth || 900) * 2.2);
    fetchNotationSvg(tune.id, key, width)
      .then((s) => live && setSvg(s))
      .catch((e) => live && setError(String(e.message || e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [tune.id, key, meta?.transcription?.id]);

  const onTranscribe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await transcribeChart(tune.id);
      setMeta(await getNotationMeta(tune.id));
    } catch (e) {
      const msg = (e as Error).message;
      setError(
        msg === "unauthorized"
          ? "Unlock the fake-book reader first."
          : msg === "no-chart"
            ? "No readable chart for this tune."
            : msg,
      );
    } finally {
      setBusy(false);
    }
  }, [tune.id]);

  return (
    <div className="notation-sheet" ref={wrap}>
      <header className="notation-head">
        <div>
          <strong>{tune.title}</strong>
          {meta?.chart && (
            <span className="notation-src">
              {" "}
              — {meta.chart.book}, p.{meta.chart.page}
            </span>
          )}
        </div>
        <button className="notation-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      {error && <p className="notation-error">{error}</p>}

      {meta && !meta.transcription && !error && (
        <div className="notation-empty">
          <p>This chart hasn’t been transcribed yet.</p>
          <button onClick={onTranscribe} disabled={busy || !meta.chart}>
            {busy ? "Reading the page…" : "Transcribe this chart"}
          </button>
          <p className="notation-note">
            Reads the printed page once, then it transposes instantly.
          </p>
        </div>
      )}

      {meta?.transcription && (
        <>
          <div className="notation-keys" role="group" aria-label="Key">
            {meta.keys.map((k) => (
              <button
                key={k}
                className={`notation-key${k === key ? " is-active" : ""}`}
                onClick={() => setKey(k)}
                aria-pressed={k === key}
              >
                {k}
              </button>
            ))}
          </div>

          <div className={`notation-canvas${busy ? " is-busy" : ""}`}>
            {/* Server-generated Verovio output, inlined so the music font in
                the document applies (an <img> would be its own document). */}
            {svg ? (
              <div dangerouslySetInnerHTML={{ __html: svg }} />
            ) : (
              <p className="notation-note">Engraving…</p>
            )}
          </div>

          <footer className="notation-foot">
            {!meta.transcription.verified && (
              <span className="notation-warn">
                Unverified — machine-read from the scan. Check it against the book.
              </span>
            )}
            {key && (
              <a href={notationMusicXmlUrl(tune.id, key)} download>
                MusicXML
              </a>
            )}
          </footer>
        </>
      )}
    </div>
  );
}

// "C-" / "Cmin" -> "C". The key pills are tonic-only; mode comes from the tune.
function stripMode(key: string): string {
  const m = /^([A-Ga-g][b#]?)/.exec(key.trim());
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : key;
}
