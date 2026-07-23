import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  deleteNotation,
  ensureNotationFont,
  fetchNotationSvg,
  getNotationMeta,
  importMusicXml,
  notationMusicXmlUrl,
  type NotationMeta,
} from "../core/notation";
import type { Tune } from "../core/types";

// The chart from the owner's fake book, re-engraved in any key. The page is
// scanned in Soundslice and corrected there, then its MusicXML export is
// imported here ONCE; every key after that is a cheap re-render of that single
// stored copy.
//
// Machine transcription used to live behind a button here. It was removed
// 2026-07-23 — it got about half the melody right, which is worse than useless
// on a stand.
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

  // Re-engrave whenever the target key changes. Aborted on unmount/key change
  // so a slow render can't land after a newer one and show the wrong key.
  useEffect(() => {
    if (!meta?.transcription || !key) return;
    const ctrl = new AbortController();
    setBusy(true);
    setError(null);
    const width = Math.round((wrap.current?.clientWidth || 900) * 2.2);
    fetchNotationSvg(tune.id, key, width, ctrl.signal)
      .then((s) => setSvg(s))
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        setError(String((e as Error).message || e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setBusy(false);
      });
    return () => ctrl.abort();
  }, [tune.id, key, meta?.transcription?.id]);

  const onImport = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // so picking the same file again still fires
      if (!file) return;
      setBusy(true);
      setError(null);
      try {
        // Pin the import to the chart this panel told you to scan. Without it
        // the server re-picks, and if the pick ever differs the file lands
        // against a page you never opened.
        await importMusicXml(tune.id, file, meta?.chart);
        setSvg(null);
        setMeta(await getNotationMeta(tune.id));
      } catch (err) {
        const msg = (err as Error).message;
        setError(
          msg === "unauthorized"
            ? "Unlock the fake-book reader first."
            : msg === "no-chart"
              ? "This tune has no chart reference to attach it to."
              : msg,
        );
      } finally {
        setBusy(false);
      }
    },
    [tune.id, meta?.chart],
  );

  const onDelete = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteNotation(tune.id, meta?.chart);
      setSvg(null);
      setMeta(await getNotationMeta(tune.id));
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  }, [tune.id, meta?.chart]);

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

      {meta && !meta.transcription && (
        <div className="notation-empty">
          <p>No notation imported for this chart yet.</p>
          <ol className="notation-steps">
            <li>
              Scan{" "}
              {meta.chart ? (
                <strong>
                  {meta.chart.book}, p.{meta.chart.page}
                </strong>
              ) : (
                "the page"
              )}{" "}
              in Soundslice
            </li>
            <li>Fix whatever it misread, then export MusicXML</li>
            <li>Drop the file in below</li>
          </ol>
          <label className={`notation-file${busy ? " is-busy" : ""}`}>
            <input
              type="file"
              accept=".musicxml,.xml,.mxl,application/vnd.recordare.musicxml+xml"
              onChange={onImport}
              disabled={busy || !meta.chart}
            />
            <span>{busy ? "Checking it engraves…" : "Import MusicXML"}</span>
          </label>
          <p className="notation-note">
            Imported once, then it transposes instantly — in every key.
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
                Unverified — check it against the book before you read it on a gig.
              </span>
            )}
            {key && (
              <a href={notationMusicXmlUrl(tune.id, key)} download>
                MusicXML
              </a>
            )}
            <label className={`notation-file notation-file-sm${busy ? " is-busy" : ""}`}>
              <input
                type="file"
                accept=".musicxml,.xml,.mxl,application/vnd.recordare.musicxml+xml"
                onChange={onImport}
                disabled={busy}
              />
              <span>{busy ? "…" : "Replace"}</span>
            </label>
            <button type="button" className="notation-drop" onClick={onDelete} disabled={busy}>
              Remove
            </button>
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
