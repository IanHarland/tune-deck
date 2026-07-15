import { useEffect, useRef, useState } from "react";
import { keyCard, toRelativeMajor, transposeKey } from "../core/keys";
import { FEEL_LABELS, type Feel, type Tune } from "../core/types";
import KeyLabel from "./KeyLabel";
import ScorePill from "./ScorePill";
import Suit from "./Suit";

// obscurity/difficulty nudged on this card (null = not touched → don't submit)
export interface WeighIn {
  obscurity: number | null;
  difficulty: number | null;
}

interface Props {
  tune: Tune | null;
  randomizedKey: string | null; // concert pitch; null = show original key
  instrumentOffset: number;
  noMinor: boolean; // display minor keys as their relative major
  onDraw: () => void; // neutral advance with no opinion recorded at all
  // swipe (like=true/dislike=false) or a neutral tap that still carries a nudge
  // (liked=null); weighIn holds any obscurity/difficulty the user moved
  onVote: (liked: boolean | null, weighIn: WeighIn) => void;
  firstVisit: boolean; // show the how-to-play on the (first) face-down back
  helpOpen: boolean; // "?" peek: re-show the instructions over the deck
  onCloseHelp: () => void;
}

const SWIPE_THRESHOLD = 90;
const FLY_MS = 260;

// balanced pip layout (max 3 per row) for a key signature's accidental count
const PIP_ROWS: Record<number, number[]> = {
  1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 6: [3, 3], 7: [3, 3, 1],
};
const pipRows = (count: number): number[] => PIP_ROWS[count] ?? [count];

export default function Deck({
  tune,
  randomizedKey,
  instrumentOffset,
  noMinor,
  onDraw,
  onVote,
  firstVisit,
  helpOpen,
  onCloseHelp,
}: Props) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [exit, setExit] = useState<"like" | "dislike" | "neutral" | null>(null);
  // obscurity/difficulty as nudged on THIS card; *Touched gates submission
  const [weigh, setWeigh] = useState({
    obscurity: 50,
    difficulty: 50,
    obsTouched: false,
    difTouched: false,
  });
  const start = useRef<{ x: number; t: number } | null>(null);
  const busy = useRef(false);

  const faceDown = tune === null;

  // reset the pills to the new tune's crowd values each time a card is dealt
  useEffect(() => {
    setWeigh({
      obscurity: tune?.obscurity_score ?? 50,
      difficulty: tune?.difficulty_score ?? 50,
      obsTouched: false,
      difTouched: false,
    });
  }, [tune?.id]);

  const setObscurity = (v: number) =>
    setWeigh((w) => ({ ...w, obscurity: v, obsTouched: true }));
  const setDifficulty = (v: number) =>
    setWeigh((w) => ({ ...w, difficulty: v, difTouched: true }));

  // animate the card out, then tell the parent what happened (carrying any nudge)
  function commit(kind: "like" | "dislike" | "neutral") {
    if (busy.current) return;
    busy.current = true;
    setDragging(false);
    setExit(kind);
    const weighIn: WeighIn = {
      obscurity: weigh.obsTouched ? weigh.obscurity : null,
      difficulty: weigh.difTouched ? weigh.difficulty : null,
    };
    const nudged = weighIn.obscurity !== null || weighIn.difficulty !== null;
    window.setTimeout(() => {
      if (faceDown) onDraw(); // the face-down deck never votes — just deal a card
      else if (kind === "like") onVote(true, weighIn);
      else if (kind === "dislike") onVote(false, weighIn);
      else if (nudged) onVote(null, weighIn); // neutral tap that still carries a nudge
      else onDraw(); // pure neutral advance
      setExit(null);
      setDx(0);
      busy.current = false;
    }, FLY_MS);
  }

  function onPointerDown(e: React.PointerEvent) {
    if (busy.current) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    start.current = { x: e.clientX, t: Date.now() };
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!start.current) return;
    setDx(e.clientX - start.current.x);
  }

  function onPointerUp() {
    if (!start.current) return;
    const moved = dx;
    const quick = Date.now() - start.current.t < 250;
    start.current = null;

    // face-down deck: nothing to judge yet, so no gesture votes — but still fly
    // the card the way it was thrown (a tap flies up) so the motion feels honest.
    if (faceDown) {
      if (Math.abs(moved) > SWIPE_THRESHOLD) commit(moved > 0 ? "like" : "dislike");
      else if (Math.abs(moved) < 8 && quick) commit("neutral");
      else snapBack();
      return;
    }
    if (Math.abs(moved) > SWIPE_THRESHOLD) commit(moved > 0 ? "like" : "dislike");
    else if (Math.abs(moved) < 8 && quick) commit("neutral"); // tap = neutral next
    else snapBack();
  }

  function snapBack() {
    setDragging(false);
    setDx(0);
  }

  const W = typeof window !== "undefined" ? window.innerWidth : 400;
  let transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
  if (exit === "like") transform = `translateX(${W * 1.3}px) rotate(22deg)`;
  else if (exit === "dislike") transform = `translateX(${-W * 1.3}px) rotate(-22deg)`;
  else if (exit === "neutral") transform = "translateY(-130%) scale(0.92)";
  // Exit accelerates away and fades (a card being thrown off); snap-back is a
  // springier settle. Keeping the two curves distinct makes the fly-up read as
  // deliberate motion rather than a stiff linear slide.
  const exiting = exit !== null;
  const transition = dragging
    ? "none"
    : exiting
      ? `transform ${FLY_MS}ms cubic-bezier(0.4, 0.05, 0.8, 0.35), opacity ${FLY_MS}ms ease-in`
      : "transform 240ms cubic-bezier(0.22, 1, 0.36, 1)";
  const topStyle: React.CSSProperties = {
    transform,
    transition,
    opacity: exiting ? 0 : 1,
  };
  const likeOpacity = Math.max(0, Math.min(1, dx / SWIPE_THRESHOLD));
  const nopeOpacity = Math.max(0, Math.min(1, -dx / SWIPE_THRESHOLD));

  return (
    <div className="deck">
      {/* depth: a couple of face-down cards behind the live one */}
      <div className="card card-back stack stack-2" aria-hidden />
      <div className="card card-back stack stack-1" aria-hidden />

      <div
        className="card top-card"
        key={tune?.id ?? "back"}
        style={topStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={snapBack}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (faceDown && (e.key === "Enter" || e.key === " ")) commit("neutral");
          else if (e.key === "ArrowRight") commit("like");
          else if (e.key === "ArrowLeft") commit("dislike");
          else if (e.key === "Enter" || e.key === " ") commit("neutral");
        }}
      >
        {faceDown ? (
          <div className="card-back-img">
            {firstVisit ? (
              <CardInstructions hint="Tap or swipe to begin" />
            ) : (
              <span className="back-hint">Tap or swipe to draw</span>
            )}
          </div>
        ) : (
          <>
            <div className="swipe-stamp stamp-like" style={{ opacity: likeOpacity }}>
              LIKE
            </div>
            <div className="swipe-stamp stamp-nope" style={{ opacity: nopeOpacity }}>
              NOPE
            </div>
            <TuneFace
              tune={tune!}
              randomizedKey={randomizedKey}
              instrumentOffset={instrumentOffset}
              noMinor={noMinor}
              obscurity={weigh.obscurity}
              difficulty={weigh.difficulty}
              onObscurity={setObscurity}
              onDifficulty={setDifficulty}
              onPillTap={() => commit("neutral")}
            />
          </>
        )}
      </div>

      {/* "?" peek: re-show the how-to-play over the deck, tap anywhere to close.
          Not a modal dialog — it's the card back shown again. */}
      {helpOpen && (
        <div
          className="card top-card help-peek"
          onPointerDown={(e) => {
            e.stopPropagation();
            onCloseHelp();
          }}
          role="button"
          aria-label="Close instructions"
        >
          <div className="card-back-img">
            <CardInstructions hint="Tap to close" />
          </div>
        </div>
      )}
    </div>
  );
}

// The how-to-play, rendered onto a card back (first-visit deck + the "?" peek).
function CardInstructions({ hint }: { hint: string }) {
  return (
    <div className="instr">
      <h3 className="instr-title">How to play</h3>
      <ul className="instr-list">
        <li>
          <span className="instr-ic" aria-hidden>👉</span>
          <span><b>Swipe right</b> — it’s hip</span>
        </li>
        <li>
          <span className="instr-ic" aria-hidden>👈</span>
          <span><b>Swipe left</b> — not hip</span>
        </li>
        <li>
          <span className="instr-ic" aria-hidden>👆</span>
          <span><b>Tap</b> — next tune, no vote</span>
        </li>
      </ul>
      <p className="instr-note">
        Drag the <b>obscurity</b> / <b>difficulty</b> bars on a tune to weigh in.
      </p>
      <span className="back-hint instr-hint">{hint}</span>
    </div>
  );
}

function TuneFace({
  tune,
  randomizedKey,
  instrumentOffset,
  noMinor,
  obscurity,
  difficulty,
  onObscurity,
  onDifficulty,
  onPillTap,
}: {
  tune: Tune;
  randomizedKey: string | null;
  instrumentOffset: number;
  noMinor: boolean;
  obscurity: number;
  difficulty: number;
  onObscurity: (v: number) => void;
  onDifficulty: (v: number) => void;
  onPillTap: () => void;
}) {
  const feels = [tune.feel, ...tune.additional_feels];
  // headline key = the just-randomized key (this view) or the tune's original.
  // keys are stored in concert pitch; transpose for the chosen instrument, then
  // (if noMinor) show minor keys as their relative major.
  const show = (k: string | null): string | null => {
    const t = transposeKey(k, instrumentOffset);
    return noMinor ? toRelativeMajor(t) : t;
  };
  const playKey = show(randomizedKey ?? tune.original_key);
  const originalKey = show(tune.original_key);
  const lastKey = show(tune.last_played_key);
  // the key signature as a playing-card rank + suit. In no-minor mode the suit
  // glyph is replaced by Electric Louie (one per accidental).
  const card = keyCard(playKey);
  const glyph = (size: number, key?: number) =>
    noMinor ? (
      <img
        key={key}
        className="louie-pip"
        src="/electric-louie.jpg"
        alt=""
        style={{ width: size, height: size }}
      />
    ) : (
      <Suit key={key} suit={card.suit!} color={card.color!} size={size} />
    );
  const index = card.suit && (
    <>
      <span className="idx-rank">{card.count}</span>
      {glyph(15)}
    </>
  );
  // shrink for long titles — by total length OR a long single word (which can't
  // wrap), so things like "Klactoveedsedstene" don't run off the card.
  const longestWord = Math.max(...tune.title.split(/\s+/).map((w) => w.length));
  const titleClass =
    tune.title.length > 30 || longestWord > 13 ? "title-xs"
    : tune.title.length > 20 || longestWord > 10 ? "title-sm"
    : "";
  // always surface the hipness — unvoted tunes legitimately sit at the neutral
  // 50 prior, so show that too (the score is never null now)
  const hip = tune.rating_score;
  return (
    // deal-in runs ONCE on mount (the .top-card key changes per tune). It must
    // NOT depend on drag state, or every tap/scroll-grab replays it (the flash).
    <div className="card-face deal-in">
      {index && <div className="card-index tl">{index}</div>}
      {index && <div className="card-index br">{index}</div>}
      {lastKey && (
        <div className="last-key-badge" title="last randomized key">
          last <KeyLabel k={lastKey} />
        </div>
      )}
      <div className="face-top">
        <span className="face-feel">
          {feels.map((f) => FEEL_LABELS[f as Feel]).join(" · ")}
        </span>
      </div>
      <h2 className={`face-title ${titleClass}`}>{tune.title}</h2>
      {tune.composer && <p className="face-composer">{tune.composer}</p>}
      {card.suit && (
        <div className="card-pips">
          {pipRows(card.count).map((n, r) => (
            <div className="pip-row" key={r}>
              {Array.from({ length: n }, (_, i) => glyph(26, i))}
            </div>
          ))}
        </div>
      )}
      {playKey && (
        <div className="face-key">
          <span className="key-big">
            <KeyLabel k={playKey} />
          </span>
          {randomizedKey ? (
            originalKey && (
              <span className="key-sub">
                original: <KeyLabel k={originalKey} />
              </span>
            )
          ) : (
            <span className="key-sub">original key</span>
          )}
        </div>
      )}
      <div className="card-scores">
        {hip != null && (
          <span className="score-badge">
            <span className="mini-heart">♥</span> <b>{Math.round(hip)}%</b>
          </span>
        )}
        <ScorePill
          label="obscurity"
          value={obscurity}
          accent="var(--teal)"
          onChange={onObscurity}
          onTap={onPillTap}
        />
        <ScorePill
          label="difficulty"
          value={difficulty}
          accent="var(--gold)"
          onChange={onDifficulty}
          onTap={onPillTap}
        />
      </div>
      <div className="face-bottom">swipe or tap for another</div>
    </div>
  );
}

