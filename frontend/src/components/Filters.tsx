import { FEELS, FEEL_LABELS, type Feel, type Filters } from "../core/types";
import Slider from "./Slider";

interface Props {
  filters: Filters;
  onChange: (f: Filters) => void;
  matchCount: number;
}

export default function FiltersPanel({ filters, onChange, matchCount }: Props) {
  const toggleFeel = (feel: Feel) => {
    const has = filters.feels.includes(feel);
    onChange({
      ...filters,
      feels: has
        ? filters.feels.filter((f) => f !== feel)
        : [...filters.feels, feel],
    });
  };

  return (
    <section className="filters">
      <div className="feel-chips">
        {FEELS.map((feel) => (
          <button
            key={feel}
            className={`chip ${filters.feels.includes(feel) ? "chip-on" : ""}`}
            onClick={() => toggleFeel(feel)}
            type="button"
          >
            {FEEL_LABELS[feel]}
          </button>
        ))}
      </div>

      <Slider
        label="Obscurity"
        leftLabel="Common"
        rightLabel="Obscure"
        value={filters.obscurity}
        onChange={(v) => onChange({ ...filters, obscurity: v })}
        accent="var(--teal)"
      />
      <Slider
        label="Difficulty"
        leftLabel="Easy"
        rightLabel="Hard"
        value={filters.difficulty}
        onChange={(v) => onChange({ ...filters, difficulty: v })}
        accent="var(--gold)"
      />

      <p className="match-count">
        {matchCount} tune{matchCount === 1 ? "" : "s"} in the deck
      </p>
    </section>
  );
}
