import { useRef } from "react";

// A draggable fill-pill: the label sits on a bar filled to `value`% in `accent`.
// Drag left/right to set it (capturing its own pointer so a parent card/list
// doesn't swipe or scroll). A tap that doesn't drag falls through to onTap.
//
// onChange fires continuously while dragging (for live fill). onCommit fires once
// on release, only if the value actually moved — used where a drag should submit
// immediately (search), vs the card which batches the vote on advance.
export default function ScorePill({
  label,
  value,
  accent,
  onChange,
  onTap,
  onCommit,
  showValue = false,
}: {
  label: string;
  value: number;
  accent: string;
  onChange: (v: number) => void;
  onTap?: () => void;
  onCommit?: (v: number) => void;
  showValue?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ moved: boolean; last: number } | null>(null);

  function valueAt(clientX: number): number {
    const el = ref.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(100, Math.round(((clientX - r.left) / r.width) * 100)));
  }
  function down(e: React.PointerEvent) {
    e.stopPropagation(); // don't let a parent card start a swipe / list scroll
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { moved: false, last: value };
  }
  function move(e: React.PointerEvent) {
    if (!drag.current) return;
    e.stopPropagation();
    const v = valueAt(e.clientX);
    drag.current.moved = true;
    drag.current.last = v;
    onChange(v);
  }
  function up(e: React.PointerEvent) {
    e.stopPropagation();
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) onTap?.();
    else onCommit?.(d.last);
  }
  return (
    <span
      ref={ref}
      className="score-pill"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <span className="score-fill" style={{ width: `${value}%`, background: accent }} />
      <span className="score-text">
        {label}
        {showValue ? ` ${Math.round(value)}` : ""}
      </span>
    </span>
  );
}
