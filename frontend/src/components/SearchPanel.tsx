import { useEffect, useMemo, useRef, useState } from "react";
import { FEEL_LABELS, type ChartRef as ChartRefT, type Feel, type Tune } from "../core/types";
import ChartRef from "./ChartRef";
import { useFakebook } from "./FakebookProvider";
import NotationSheet from "./NotationSheet";
import ScorePill from "./ScorePill";

type VoteFn = (
  tuneId: string,
  vote: { liked?: boolean | null; obscurity?: number; difficulty?: number },
) => void;

interface Props {
  tunes: Tune[];
  onClose: () => void;
  onVote: VoteFn;
}

const MAX_RESULTS = 60;
const TRAILING_NUM = /\s+\d+$/; // a dup marker like " 2" (only when siblings share the base)

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// The library stores titles library-style: the article moved to the end
// ("Way You Look Tonight, The"), and duplicate charts disambiguated with a
// trailing number ("Way You Look Tonight, The 2"). deArticle rebuilds a natural
// "The Way You Look Tonight [2]" (keeping any number). A trailing number is only
// treated as a dup marker when another tune shares the base — otherwise it's
// part of the title ("Route 66", "Unit 7"), so we never blindly strip it.
function deArticle(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^(.*?),\s+(the|a|an)(\s+\d+)?$/i);
  return m ? `${m[2]} ${m[1]}${m[3] ?? ""}` : t;
}
const stripNum = (s: string) => s.replace(TRAILING_NUM, "");
// search key: de-articled, leading article dropped. Trailing numbers are kept —
// they sit at the end so they don't hurt prefix/substring matching.
const matchKey = (s: string) => norm(deArticle(s).replace(/^(the|a|an)\s+/i, ""));
// base key: also drops the trailing number — used to detect/merge duplicates.
const baseKey = (s: string) => norm(stripNum(deArticle(s)).replace(/^(the|a|an)\s+/i, ""));
const hasNum = (s: string) => TRAILING_NUM.test(s.trim());

// One row per distinct tune (duplicate charts collapsed). `tune` is the canonical
// entry used for showing/recording the crowd ratings; charts merge every copy.
interface Hit {
  key: string;
  title: string;
  composer: string | null;
  feel: Feel;
  charts: ChartRefT[];
  tune: Tune;
}

// Lookup panel — mostly a "which fake book is this tune in?" tool. Type a title
// (or composer) and get matching tunes, each showing its fake-book refs and its
// crowd obscurity/difficulty/hipness ratings, which you can vote on inline.
export default function SearchPanel({ tunes, onClose, onVote }: Props) {
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

  // how many tunes share each de-numbered base title — a trailing number only
  // counts as a dup marker when the base has siblings (≥2).
  const baseCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tunes) {
      const k = baseKey(t.title);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [tunes]);

  const results = useMemo<Hit[]>(() => {
    const nq = matchKey(q);
    if (!nq) return [];

    const scored: { t: Tune; rank: number }[] = [];
    for (const t of tunes) {
      const tk = matchKey(t.title);
      const alt = t.alternate_titles.map(matchKey);
      const comp = t.composer ? norm(t.composer) : "";
      let rank = -1;
      if (tk.startsWith(nq)) rank = 0;
      else if (tk.includes(nq)) rank = 1;
      else if (alt.some((k) => k.includes(nq))) rank = 2;
      else if (comp.includes(nq)) rank = 3;
      if (rank >= 0) scored.push({ t, rank });
    }
    scored.sort(
      (a, b) => a.rank - b.rank || deArticle(a.t.title).localeCompare(deArticle(b.t.title)),
    );

    // collapse duplicate charts of the same tune into one row, merging fake books
    const byKey = new Map<string, Hit>();
    for (const { t } of scored) {
      const isDup = hasNum(t.title) && (baseCounts.get(baseKey(t.title)) ?? 0) >= 2;
      const gkey = isDup ? baseKey(t.title) : matchKey(t.title);
      let hit = byKey.get(gkey);
      if (!hit) {
        hit = {
          key: gkey,
          title: isDup ? stripNum(deArticle(t.title)) : deArticle(t.title),
          composer: t.composer,
          feel: t.feel,
          charts: [],
          tune: t, // the first (canonical, non-numbered) copy carries the ratings
        };
        byKey.set(gkey, hit);
      } else if (!hit.composer && t.composer) {
        hit.composer = t.composer;
      }
      for (const c of t.charts) {
        if (!hit.charts.some((x) => x.book === c.book && x.page === c.page)) {
          hit.charts.push(c);
        }
      }
    }
    return [...byKey.values()].slice(0, MAX_RESULTS);
  }, [q, tunes, baseCounts]);

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
              {results.map((hit) => (
                <SearchResult key={hit.key} hit={hit} onVote={onVote} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// A single result: title + fake-book refs, plus the crowd ratings you can vote
// on inline (drag obscurity/difficulty; 👍/👎 for hipness).
function SearchResult({ hit, onVote }: { hit: Hit; onVote: VoteFn }) {
  const t = hit.tune;
  const { hasNotation } = useFakebook();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [obs, setObs] = useState(t.obscurity_score);
  const [dif, setDif] = useState(t.difficulty_score);
  // re-sync to the crowd value after a vote updates this tune
  useEffect(() => setObs(t.obscurity_score), [t.obscurity_score]);
  useEffect(() => setDif(t.difficulty_score), [t.difficulty_score]);
  const hip = t.rating_score;

  return (
    <li className="search-result">
      <div className="search-result__head">
        <span className="search-result__title">{hit.title}</span>
        <span className="search-result__meta">
          {FEEL_LABELS[hit.feel]}
          {hit.composer ? ` · ${hit.composer}` : ""}
        </span>
      </div>

      <div className="search-scores">
        <ScorePill
          label="obscurity"
          value={obs}
          accent="var(--teal)"
          showValue
          onChange={setObs}
          onCommit={(v) => onVote(t.id, { obscurity: v })}
        />
        <ScorePill
          label="difficulty"
          value={dif}
          accent="var(--gold)"
          showValue
          onChange={setDif}
          onCommit={(v) => onVote(t.id, { difficulty: v })}
        />
        <div className="hip-vote">
          <span className="hip-readout">
            <span className="mini-heart">♥</span>
            {hip != null ? ` ${Math.round(hip)}%` : " —"}
          </span>
          <button
            className="hip-btn"
            onClick={() => onVote(t.id, { liked: true })}
            aria-label="Vote hip"
            title="Hip"
          >
            👍
          </button>
          <button
            className="hip-btn"
            onClick={() => onVote(t.id, { liked: false })}
            aria-label="Vote not hip"
            title="Not hip"
          >
            👎
          </button>
        </div>
      </div>

      {hit.charts.length > 0 ? (
        <ul className="charts-list">
          {hit.charts.map((c, i) => (
            <ChartRef key={i} chart={c} title={hit.title} />
          ))}
        </ul>
      ) : (
        <span className="search-result__nochart">not in the indexed fake books</span>
      )}

      {/* Same rule as the result card: only where a chart has been imported.
          Chart rows stay one-tap-one-action, so this is its own control. */}
      {hasNotation(t.id) && (
        <button
          className="btn btn-ghost btn-notation"
          onClick={() => setSheetOpen((v) => !v)}
          aria-expanded={sheetOpen}
        >
          {sheetOpen ? "Hide notation" : "🎼 Read in any key"}
        </button>
      )}
      {sheetOpen && (
        <NotationSheet
          tune={t}
          currentKey={t.last_played_key ?? t.original_key ?? null}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </li>
  );
}
