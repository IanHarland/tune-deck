import { useRef, useState } from "react";
import { keyCard, toRelativeMajor, transposeKey } from "../core/keys";
import { FEEL_LABELS, type Feel, type Tune } from "../core/types";
import KeyLabel from "./KeyLabel";
import Suit from "./Suit";

interface Props {
  tune: Tune | null;
  randomizedKey: string | null; // concert pitch; null = show original key
  instrumentOffset: number;
  noMinor: boolean; // display minor keys as their relative major
  onDraw: () => void; // neutral advance (tap) — no opinion recorded
  onVote: (liked: boolean) => void; // swipe right=like / left=dislike
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
}: Props) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [exit, setExit] = useState<"like" | "dislike" | "neutral" | null>(null);
  const start = useRef<{ x: number; t: number } | null>(null);
  const busy = useRef(false);

  const faceDown = tune === null;

  // animate the card out, then tell the parent what happened
  function commit(kind: "like" | "dislike" | "neutral") {
    if (busy.current) return;
    busy.current = true;
    setDragging(false);
    setExit(kind);
    window.setTimeout(() => {
      if (kind === "like") onVote(true);
      else if (kind === "dislike") onVote(false);
      else onDraw();
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

    // face-down deck: nothing to judge yet — any deliberate gesture just draws
    if (faceDown) {
      if (Math.abs(moved) > SWIPE_THRESHOLD || (Math.abs(moved) < 8 && quick))
        commit("neutral");
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
  const topStyle: React.CSSProperties = {
    transform,
    transition: dragging ? "none" : `transform ${FLY_MS}ms ease-out`,
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
            <span className="back-hint">Tap or swipe to draw</span>
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
            />
          </>
        )}
      </div>
    </div>
  );
}

function TuneFace({
  tune,
  randomizedKey,
  instrumentOffset,
  noMinor,
}: {
  tune: Tune;
  randomizedKey: string | null;
  instrumentOffset: number;
  noMinor: boolean;
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
        <span className="score-badge">
          obscurity <b>{Math.round(tune.obscurity_score)}</b>
        </span>
        <span className="score-badge">
          difficulty <b>{Math.round(tune.difficulty_score)}</b>
        </span>
      </div>
      <div className="face-bottom">swipe or tap for another</div>
    </div>
  );
}
