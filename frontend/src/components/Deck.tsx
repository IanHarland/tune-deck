import { useRef, useState } from "react";
import { keyCard, transposeKey } from "../core/keys";
import { FEEL_LABELS, type Feel, type Tune } from "../core/types";
import KeyLabel from "./KeyLabel";
import Suit from "./Suit";

interface Props {
  tune: Tune | null;
  randomizedKey: string | null; // concert pitch; null = show original key
  instrumentOffset: number;
  onDraw: () => void;
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
  onDraw,
}: Props) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; t: number } | null>(null);
  const busy = useRef(false);

  const faceDown = tune === null;

  function triggerDraw(direction: number) {
    if (busy.current) return;
    busy.current = true;
    setDragging(false);
    setDx(direction * window.innerWidth * 1.2);
    window.setTimeout(() => {
      onDraw();
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

    if (Math.abs(moved) > SWIPE_THRESHOLD) {
      triggerDraw(moved > 0 ? 1 : -1);
    } else if (Math.abs(moved) < 8 && quick) {
      // tap — only draws from a face-down deck (avoids accidental redraws)
      if (faceDown) triggerDraw(1);
      else snapBack();
    } else {
      snapBack();
    }
  }

  function snapBack() {
    setDragging(false);
    setDx(0);
  }

  const rotate = dx / 22;
  const topStyle: React.CSSProperties = {
    transform: `translateX(${dx}px) rotate(${rotate}deg)`,
    transition: dragging ? "none" : `transform ${FLY_MS}ms ease-out`,
  };

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
          if (e.key === "Enter" || e.key === " ") triggerDraw(1);
        }}
      >
        {faceDown ? (
          <div className="card-back-img">
            <span className="back-hint">Tap or swipe to draw</span>
          </div>
        ) : (
          <TuneFace
            tune={tune!}
            randomizedKey={randomizedKey}
            instrumentOffset={instrumentOffset}
          />
        )}
      </div>
    </div>
  );
}

function TuneFace({
  tune,
  randomizedKey,
  instrumentOffset,
}: {
  tune: Tune;
  randomizedKey: string | null;
  instrumentOffset: number;
}) {
  const feels = [tune.feel, ...tune.additional_feels];
  // headline key = the just-randomized key (this view) or the tune's original.
  // keys are stored in concert pitch; transpose for the chosen instrument.
  const concertPlayKey = randomizedKey ?? tune.original_key;
  const playKey = transposeKey(concertPlayKey, instrumentOffset);
  const originalKey = transposeKey(tune.original_key, instrumentOffset);
  const lastKey = transposeKey(tune.last_played_key, instrumentOffset);
  // the key signature as a playing-card rank + suit
  const card = keyCard(playKey);
  const index = card.suit && (
    <>
      <span className="idx-rank">{card.count}</span>
      <Suit suit={card.suit} color={card.color!} size={15} />
    </>
  );
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
      <h2 className="face-title">{tune.title}</h2>
      {tune.composer && <p className="face-composer">{tune.composer}</p>}
      {card.suit && (
        <div className="card-pips">
          {pipRows(card.count).map((n, r) => (
            <div className="pip-row" key={r}>
              {Array.from({ length: n }, (_, i) => (
                <Suit key={i} suit={card.suit!} color={card.color!} size={26} />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="face-key">
        <span className="key-big">
          <KeyLabel k={playKey} />
        </span>
        <span className="key-sub">
          {randomizedKey ? (
            <>
              original: <KeyLabel k={originalKey} />
            </>
          ) : (
            "original key"
          )}
        </span>
      </div>
      <div className="card-scores">
        <span className="score-badge">
          obscurity <b>{Math.round(tune.obscurity_score)}</b>
        </span>
        <span className="score-badge">
          difficulty <b>{Math.round(tune.difficulty_score)}</b>
        </span>
      </div>
      <div className="face-bottom">swipe for another</div>
    </div>
  );
}
