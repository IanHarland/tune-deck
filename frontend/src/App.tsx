import { useEffect, useMemo, useRef, useState } from "react";
import { castVote, getTunes, recordPick, undoVote } from "./core/api";
import { deckTunes, pickRandomTune } from "./core/tunePicker";
import type { Filters, Mode, Tune } from "./core/types";
import Deck, { type WeighIn } from "./components/Deck";
import { FakebookProvider } from "./components/FakebookProvider";
import FiltersPanel from "./components/Filters";
import InstrumentSelector from "./components/InstrumentSelector";
import ModeSelector from "./components/ModeSelector";
import NoMinorToggle from "./components/NoMinorToggle";
import InstallButton from "./components/InstallButton";
import ResultControls from "./components/ResultControls";
import SearchPanel from "./components/SearchPanel";
import { useAnonId } from "./useAnonId";
import { useInstrument } from "./useInstrument";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// shown once per device, then re-openable from the header "?"
const INTRO_KEY = "tunedeck.seenIntro";

// Persisted per-device slider prefs: the three weigh-in sliders + their on/off
// state. The hard feel filter and excludeHenny are left fresh each session, so
// they're deliberately not saved.
const FILTERS_KEY = "tunedeck.filters";

const DEFAULT_FILTERS: Filters = {
  feels: [],
  obscurity: 10, // aim at the canon by default; slide up to explore deep cuts
  difficulty: 50,
  hipness: 50,
  obscurityOn: true,
  difficultyOn: true,
  hipnessOn: false, // opt-in: ratings are sparse at first
  excludeHenny: false,
};

function loadFilters(): Filters {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || "{}");
    const num = (v: unknown, d: number) =>
      typeof v === "number" && v >= 0 && v <= 100 ? v : d;
    const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
    return {
      ...DEFAULT_FILTERS,
      obscurity: num(saved.obscurity, DEFAULT_FILTERS.obscurity),
      difficulty: num(saved.difficulty, DEFAULT_FILTERS.difficulty),
      hipness: num(saved.hipness, DEFAULT_FILTERS.hipness),
      obscurityOn: bool(saved.obscurityOn, DEFAULT_FILTERS.obscurityOn),
      difficultyOn: bool(saved.difficultyOn, DEFAULT_FILTERS.difficultyOn),
      hipnessOn: bool(saved.hipnessOn, DEFAULT_FILTERS.hipnessOn),
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

// "Lame" mode alternates Spain with one of these wedding-band warhorses. Titles
// must match the library (Ipanema is stored "...The"); Cantaloupe Island and
// Chameleon aren't in the iReal backup yet, so they simply no-op until added.
const LAME_TUNES = [
  "Autumn Leaves",
  "Blue Bossa",
  "Satin Doll",
  "Take the 'A' Train",
  "All Blues",
  "Girl From Ipanema, The",
  "Fly Me to the Moon",
  "Take Five",
  "Summertime",
  "Cantaloupe Island",
  "My Funny Valentine",
  "Misty",
  "Body and Soul",
  "Georgia on My Mind",
  "All of Me",
  "Mack the Knife",
  "What a Wonderful World",
  "Watermelon Man",
  "St. Thomas",
  "So What",
  "Stella by Starlight",
  "There Will Never Be Another You",
  "Chameleon",
];

export default function App() {
  const [tunes, setTunes] = useState<Tune[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const [current, setCurrent] = useState<Tune | null>(null);
  const [mode, setMode] = useState<Mode>("normal");
  const [noMinor, setNoMinor] = useState(false); // show minor keys as rel. major
  // the randomized key for THIS view only (concert pitch). Null = show original.
  // Deliberately session-local so a stale global last_played_key never becomes
  // the headline on a tune the user hasn't randomized.
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  // Undo history: a stack of cards we've left behind, newest last. Every advance
  // (a vote, a nudge, or a plain tap) pushes the card being left, so undo walks
  // back through all of them — votes get their rating row deleted, taps just
  // restore the card. ratingId is filled in async once castVote returns; id lets
  // us target the right entry if several are in flight.
  const [history, setHistory] = useState<
    { id: number; tune: Tune; ratingId: string | null; sessionKey: string | null }[]
  >([]);
  const histId = useRef(0);
  // first-run tutorial lives on the FIRST card's back (not a modal). Gated by
  // localStorage so it shows once per device, then reverts to the plain back.
  // The "?" reopens it as a non-modal peek over the deck.
  const [seenIntro, setSeenIntro] = useState<boolean>(() => {
    try {
      return localStorage.getItem(INTRO_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const anonId = useAnonId();
  const [instrument, setInstrument] = useInstrument();
  // tunes already suggested this round; skipped on draw until the pool is
  // exhausted, and reset whenever the filters/mode change.
  const suggested = useRef<Set<string>>(new Set());
  const lameOn = useRef(false); // lame mode: every other draw is Spain

  // getTunes retries through the cold-start wake internally; if it still fails
  // (or the user taps "Try again"), reset and re-run rather than dead-ending.
  function loadTunes() {
    setError(null);
    getTunes()
      .then(setTunes)
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    loadTunes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // remember the slider settings (values + on/off) per device for next visit
  useEffect(() => {
    try {
      localStorage.setItem(
        FILTERS_KEY,
        JSON.stringify({
          obscurity: filters.obscurity,
          difficulty: filters.difficulty,
          hipness: filters.hipness,
          obscurityOn: filters.obscurityOn,
          difficultyOn: filters.difficultyOn,
          hipnessOn: filters.hipnessOn,
        }),
      );
    } catch {
      /* private mode / storage disabled — fine, just won't persist */
    }
  }, [filters]);

  // new filters/mode ⇒ fresh round, forget what's been suggested
  useEffect(() => {
    suggested.current = new Set();
    lameOn.current = false;
  }, [filters, mode]);

  // deck size depends only on the HARD feel filter, not the soft sliders
  const matchCount = useMemo(
    () => (tunes ? deckTunes(tunes, filters).length : 0),
    [tunes, filters.feels, filters.excludeHenny],
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
    markIntroSeen(); // drawing the first card retires the how-to-play back
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
        // every other draw: a random tune from the curated lame list (filters
        // ignored — the list IS the curation), avoiding repeats until exhausted
        const pool = LAME_TUNES.map(findTune).filter(
          (t): t is Tune => t !== null,
        );
        const fresh = pool.filter((t) => !suggested.current.has(t.id));
        const choose = fresh.length ? fresh : pool;
        next = choose.length
          ? choose[Math.floor(Math.random() * choose.length)]
          : null;
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

  // randomize: show the new key in THIS view only. It is NOT persisted — the
  // tune's last_played_key updates only when the user marks it played.
  function handleRandomized(key: string) {
    setSessionKey(key);
  }

  // patch a tune's crowd aggregates in the in-memory pool after a vote/undo
  function patchScores(updated: Tune) {
    setTunes((prev) =>
      prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev,
    );
  }

  // vote from the search view: record it and fold the fresh crowd scores back
  // into the shared pool so the deck and search stay in sync. No undo tracking.
  async function recordSearchVote(
    tuneId: string,
    vote: { liked?: boolean | null; obscurity?: number; difficulty?: number },
  ) {
    try {
      const { tune: updated } = await castVote(tuneId, vote, anonId);
      patchScores(updated);
    } catch (e) {
      console.error(e);
    }
  }

  // push the card we're leaving onto the undo stack, returning its entry id so a
  // later castVote can attach its rating row. Returns null if there's no card.
  function pushHistory(): number | null {
    if (!current) return null;
    const id = ++histId.current;
    const left = current;
    const key = sessionKey;
    setHistory((h) => [...h, { id, tune: left, ratingId: null, sessionKey: key }]);
    return id;
  }

  // plain advance (tap / swipe with no opinion): undoable, but no server write
  function handleDraw() {
    pushHistory();
    draw();
  }

  // swipe (like/dislike) or a nudge-carrying tap → record it, then advance.
  async function handleVote(liked: boolean | null, weighIn: WeighIn) {
    const voted = current;
    const entryId = pushHistory();
    draw(); // advance immediately; the vote round-trips in the background
    if (!voted) return;
    try {
      const { tune: updated, rating_id } = await castVote(
        voted.id,
        { liked, obscurity: weighIn.obscurity, difficulty: weighIn.difficulty },
        anonId,
      );
      patchScores(updated);
      // attach the rating row to its history entry so undo can delete it
      if (entryId !== null) {
        setHistory((h) =>
          h.map((e) => (e.id === entryId ? { ...e, ratingId: rating_id } : e)),
        );
      }
    } catch (e) {
      console.error(e);
    }
  }

  // step back one card: restore it (and its view), and if it carried a vote,
  // delete that rating row. Repeatable until the stack is empty.
  function handleUndo() {
    if (history.length === 0) return;
    const entry = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setSessionKey(entry.sessionKey);
    setCurrent(entry.tune);
    if (entry.ratingId) {
      undoVote(entry.ratingId)
        .then((reverted) => {
          patchScores(reverted);
          setCurrent((c) => (c && c.id === reverted.id ? reverted : c));
        })
        .catch((e) => console.error(e));
    }
  }

  function markIntroSeen() {
    if (seenIntro) return;
    setSeenIntro(true);
    try {
      localStorage.setItem(INTRO_KEY, "1");
    } catch {
      /* private mode / storage disabled — fine, just shows again next visit */
    }
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
    <FakebookProvider edition={instrument.id}>
    <div className="app">
      <header className="app-header">
        <h1 className="logo">
          TUNE<img className="logo-emblem" src="/emblem.png" alt="·" />DECK
        </h1>
        <p className="tagline">draw a tune for the set</p>
      </header>

      <FiltersPanel
        filters={filters}
        onChange={setFilters}
        matchCount={matchCount}
      />

      <div className="selectors">
        <div className="sel-group">
          <InstrumentSelector instrument={instrument} onChange={setInstrument} />
          <NoMinorToggle on={noMinor} onChange={setNoMinor} />
          {tunes && (
            <button
              type="button"
              className="search-btn"
              onClick={() => setSearchOpen(true)}
              aria-label="Search tunes"
              title="Search tunes"
            >
              <svg
                viewBox="0 0 24 24"
                width="26"
                height="26"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden
              >
                <circle cx="10.5" cy="10.5" r="6.5" />
                <line x1="15.5" y1="15.5" x2="20.5" y2="20.5" />
              </svg>
            </button>
          )}
        </div>
        <ModeSelector mode={mode} onChange={setMode} />
      </div>

      <main className="stage">
        {error ? (
          <div className="loading load-error">
            <p>Couldn’t reach the server — it may be waking up.</p>
            <button className="retry-btn" onClick={loadTunes}>
              Try again
            </button>
          </div>
        ) : !tunes ? (
          <p className="loading">Shuffling the deck…</p>
        ) : matchCount === 0 ? (
          <p className="loading">No tunes match — loosen the filters.</p>
        ) : (
          <Deck
            tune={current}
            randomizedKey={sessionKey}
            instrumentOffset={instrument.offset}
            noMinor={noMinor}
            onDraw={handleDraw}
            onVote={handleVote}
            firstVisit={!seenIntro}
            helpOpen={helpOpen}
            onCloseHelp={() => setHelpOpen(false)}
          />
        )}
      </main>

      <div className="deck-actions">
        <button
          className="help-btn"
          onClick={() => setHelpOpen((v) => !v)}
          aria-label="How to play"
          aria-pressed={helpOpen}
          title="How to play"
        >
          ?
        </button>
        <button
          className="undo-btn"
          onClick={handleUndo}
          disabled={history.length === 0}
        >
          ↩ undo
        </button>
      </div>

      {current && (
        <ResultControls
          tune={current}
          currentKey={sessionKey ?? current.original_key}
          onUpdate={updateCurrent}
          onDelete={removeCurrent}
          onRandomized={handleRandomized}
        />
      )}

      <InstallButton />

      <footer className="app-footer">
        {current ? "swipe the card for another tune" : "tap the deck to begin"}
      </footer>

      {searchOpen && tunes && (
        <SearchPanel
          tunes={tunes}
          onClose={() => setSearchOpen(false)}
          onVote={recordSearchVote}
          instrument={instrument}
          onInstrumentChange={setInstrument}
        />
      )}
    </div>
    </FakebookProvider>
  );
}
