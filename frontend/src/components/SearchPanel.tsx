import { useEffect, useMemo, useRef, useState } from "react";
import { coverSlug } from "../core/covers";
import { FEEL_LABELS, type Tune } from "../core/types";

interface Props {
  tunes: Tune[];
  onClose: () => void;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const MAX_RESULTS = 60;

// Lookup panel — mostly a "which fake book is this tune in?" tool. Type a title
// (or composer) and get matching tunes, each showing its fake-book + page refs.
export default function SearchPanel({ tunes, onClose }: Props) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const results = useMemo(() => {
    const nq = norm(q);
    if (!nq) return [];
    const scored: { t: Tune; rank: number }[] = [];
    for (const t of tunes) {
      const title = norm(t.title);
      let rank = -1;
      if (title.startsWith(nq)) rank = 0;
      else if (title.includes(nq)) rank = 1;
      else if (t.alternate_titles.some((a) => norm(a).includes(nq))) rank = 2;
      else if (t.composer && norm(t.composer).includes(nq)) rank = 3;
      if (rank >= 0) scored.push({ t, rank });
    }
    scored.sort((a, b) => a.rank - b.rank || a.t.title.localeCompare(b.t.title));
    return scored.slice(0, MAX_RESULTS).map((s) => s.t);
  }, [q, tunes]);

  return (
    <div
      className="search-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Search tunes"
      onClick={onClose}
    >
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-bar">
          <input
            ref={inputRef}
            className="search-input"
            type="search"
            placeholder="Search a tune or composer…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button className="search-close" onClick={onClose} aria-label="Close search">
            ✕
          </button>
        </div>

        <div className="search-results">
          {q.trim() === "" ? (
            <p className="search-hint">Type a tune title to find its fake-book chart.</p>
          ) : results.length === 0 ? (
            <p className="search-hint">No tunes match “{q.trim()}”.</p>
          ) : (
            <ul className="search-list">
              {results.map((t) => (
                <li key={t.id} className="search-result">
                  <div className="search-result__head">
                    <span className="search-result__title">{t.title}</span>
                    <span className="search-result__meta">
                      {FEEL_LABELS[t.feel]}
                      {t.composer ? ` · ${t.composer}` : ""}
                    </span>
                  </div>
                  {t.charts.length > 0 ? (
                    <ul className="charts-list">
                      {t.charts.map((c, i) => (
                        <li key={i} className="chart-ref">
                          <img
                            className="chart-cover"
                            src={`/covers/${coverSlug(c.book)}.jpg`}
                            alt=""
                            loading="lazy"
                            onError={(e) => {
                              e.currentTarget.style.visibility = "hidden";
                            }}
                          />
                          <span className="chart-book">{c.book}</span>
                          <span className="chart-page">p.{c.page}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="search-result__nochart">
                      not in the indexed fake books
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
