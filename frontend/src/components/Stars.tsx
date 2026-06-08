import { useState } from "react";

interface Props {
  value: number; // 0..5, 0 = not yet picked
  onChange: (n: number) => void;
}

// A 1–5 star picker. Hover previews on desktop; tap sets on mobile. Clicking the
// current value again clears it back to unrated.
export default function Stars({ value, onChange }: Props) {
  const [hover, setHover] = useState(0);
  const active = hover || value;
  return (
    <div className="stars" role="radiogroup" aria-label="How much do you like it?">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={`star ${n <= active ? "star-on" : ""}`}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={() => onChange(n === value ? 0 : n)}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          aria-pressed={n <= value}
        >
          {n <= active ? "★" : "☆"}
        </button>
      ))}
    </div>
  );
}
