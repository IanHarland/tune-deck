import { useEffect, useMemo, useRef, useState } from "react";
import { getTunes, recordPick } from "./core/api";
import { deckTunes, pickRandomTune } from "./core/tunePicker";
import type { Filters, Tune } from "./core/types";
import Deck from "./components/Deck";
import FiltersPanel from "./components/Filters";
import InstrumentSelector from "./components/InstrumentSelector";
import ResultControls from "./components/ResultControls";
import { useAnonId } from "./useAnonId";
import { useInstrument } from "./useInstrument";

export default function App() {
  const [tunes, setTunes] = useState<Tune[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({
    feels: [],
    obscurity: 10, // aim at the canon by default; slide up to explore deep cuts
    difficulty: 50,
  });
  const [current, setCurrent] = useState<Tune | null>(null);
  // the randomized key for THIS view only (concert pitch). Null = show original.
  // Deliberately session-local so a stale global last_played_key never becomes
  // the headline on a tune the user hasn't randomized.
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const anonId = useAnonId();
  const [instrument, setInstrument] = useInstrument();
  // tunes already suggested this round; skipped on draw until the pool is
  // exhausted, and reset whenever the filters change.
  const suggested = useRef<Set<string>>(new Set());

  useEffect(() => {
    getTunes()
      .then(setTunes)
      .catch((e) => setError(String(e)));
  }, []);

  // new filters ⇒ fresh round, forget what's been suggested
  useEffect(() => {
    suggested.current = new Set();
  }, [filters]);

  // deck size depends only on the HARD feel filter, not the soft sliders
  const matchCount = useMemo(
    () => (tunes ? deckTunes(tunes, filters).length : 0),
    [tunes, filters.feels],
  );

  function draw() {
    if (!tunes) return;
    const next = pickRandomTune(tunes, filters, suggested.current);
    if (next) {
      // picker cycled (returned an already-seen tune) ⇒ start a fresh round
      if (suggested.current.has(next.id)) suggested.current = new Set();
      suggested.current.add(next.id);
      recordPick(next.id).catch(() => {});
    }
    setSessionKey(null); // new tune always starts on its original key
    setCurrent(next);
  }

  // keep both the drawn card and the in-memory pool in sync after updates
  function updateCurrent(updated: Tune) {
    setCurrent(updated);
    setTunes((prev) =>
      prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev,
    );
  }

  // randomize: show the new key in this view AND remember it as the tune's
  // last-played key (the corner badge / next time it comes up).
  function handleRandomized(key: string) {
    setSessionKey(key);
    if (current) updateCurrent({ ...current, last_played_key: key });
  }

  // drop a tune from the pool and deal the next one
  function removeCurrent(id: string) {
    const remaining = (tunes ?? []).filter((t) => t.id !== id);
    setTunes(remaining);
    const next = pickRandomTune(remaining, filters, suggested.current);
    if (next) {
      if (suggested.current.has(next.id)) suggested.current = new Set();
      suggested.current.add(next.id);
    }
    setSessionKey(null);
    setCurrent(next);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="logo">
          TUNE<span className="logo-dot">·</span>DECK
        </h1>
        <p className="tagline">draw a tune for the set</p>
      </header>

      {error && <p className="error">Couldn’t load tunes: {error}</p>}

      <FiltersPanel
        filters={filters}
        onChange={setFilters}
        matchCount={matchCount}
      />

      <InstrumentSelector instrument={instrument} onChange={setInstrument} />

      <main className="stage">
        {!tunes ? (
          <p className="loading">Shuffling the deck…</p>
        ) : matchCount === 0 ? (
          <p className="loading">No tunes match — loosen the filters.</p>
        ) : (
          <Deck
            tune={current}
            randomizedKey={sessionKey}
            instrumentOffset={instrument.offset}
            onDraw={draw}
          />
        )}
      </main>

      {current && (
        <ResultControls
          tune={current}
          anonId={anonId}
          onUpdate={updateCurrent}
          onDelete={removeCurrent}
          onRandomized={handleRandomized}
        />
      )}

      <footer className="app-footer">
        {current ? "swipe the card for another tune" : "tap the deck to begin"}
      </footer>
    </div>
  );
}
