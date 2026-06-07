import { useEffect, useMemo, useRef, useState } from "react";
import { getTunes, recordPick } from "./core/api";
import { deckTunes, pickRandomTune } from "./core/tunePicker";
import type { Filters, Mode, Tune } from "./core/types";
import Deck from "./components/Deck";
import FiltersPanel from "./components/Filters";
import InstrumentSelector from "./components/InstrumentSelector";
import ModeSelector from "./components/ModeSelector";
import ResultControls from "./components/ResultControls";
import { useAnonId } from "./useAnonId";
import { useInstrument } from "./useInstrument";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export default function App() {
  const [tunes, setTunes] = useState<Tune[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({
    feels: [],
    obscurity: 10, // aim at the canon by default; slide up to explore deep cuts
    difficulty: 50,
    obscurityOn: true,
    difficultyOn: true,
  });
  const [current, setCurrent] = useState<Tune | null>(null);
  const [mode, setMode] = useState<Mode>("normal");
  // the randomized key for THIS view only (concert pitch). Null = show original.
  // Deliberately session-local so a stale global last_played_key never becomes
  // the headline on a tune the user hasn't randomized.
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const anonId = useAnonId();
  const [instrument, setInstrument] = useInstrument();
  // tunes already suggested this round; skipped on draw until the pool is
  // exhausted, and reset whenever the filters/mode change.
  const suggested = useRef<Set<string>>(new Set());
  const lameOn = useRef(false); // lame mode: every other draw is Spain

  useEffect(() => {
    getTunes()
      .then(setTunes)
      .catch((e) => setError(String(e)));
  }, []);

  // new filters/mode ⇒ fresh round, forget what's been suggested
  useEffect(() => {
    suggested.current = new Set();
    lameOn.current = false;
  }, [filters, mode]);

  // deck size depends only on the HARD feel filter, not the soft sliders
  const matchCount = useMemo(
    () => (tunes ? deckTunes(tunes, filters).length : 0),
    [tunes, filters.feels],
  );

  const findTune = (title: string): Tune | null =>
    tunes?.find((t) => norm(t.title) === norm(title)) ?? null;

  // record a normal pick into the no-repeat set (cycling when exhausted)
  function remember(t: Tune) {
    if (suggested.current.has(t.id)) suggested.current = new Set();
    suggested.current.add(t.id);
  }

  function draw() {
    if (!tunes) return;
    let next: Tune | null;
    if (mode === "spain") {
      next = findTune("Spain");
    } else if (mode === "smalls") {
      const pool = ["Firm Roots", "Spain"]
        .map(findTune)
        .filter((t): t is Tune => t !== null);
      next = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    } else if (mode === "lame") {
      lameOn.current = !lameOn.current;
      if (lameOn.current) {
        next = findTune("Spain");
      } else {
        next = pickRandomTune(tunes, filters, suggested.current);
        if (next) remember(next);
      }
    } else {
      next = pickRandomTune(tunes, filters, suggested.current, mode);
      if (next) remember(next);
    }
    if (next) recordPick(next.id).catch(() => {});
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
    const next = pickRandomTune(remaining, filters, suggested.current, mode);
    if (next) remember(next);
    setSessionKey(null);
    setCurrent(next);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="logo">
          TUNE<img className="logo-emblem" src="/emblem.png" alt="·" />DECK
        </h1>
        <p className="tagline">draw a tune for the set</p>
      </header>

      {error && <p className="error">Couldn’t load tunes: {error}</p>}

      <FiltersPanel
        filters={filters}
        onChange={setFilters}
        matchCount={matchCount}
      />

      <div className="selectors">
        <InstrumentSelector instrument={instrument} onChange={setInstrument} />
        <ModeSelector mode={mode} onChange={setMode} />
      </div>

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
