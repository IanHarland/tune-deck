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
        leftLabel="Flesh wound"
        rightLabel="Deep Cut"
        enabled={filters.obscurityOn}
        value={filters.obscurity}
        onToggle={() =>
          onChange({ ...filters, obscurityOn: !filters.obscurityOn })
        }
        onChange={(v) => onChange({ ...filters, obscurity: v })}
        accent="var(--teal)"
      />
      <Slider
        label="Difficulty"
        leftLabel="Yawn"
        rightLabel="Yikes"
        enabled={filters.difficultyOn}
        value={filters.difficulty}
        onToggle={() =>
          onChange({ ...filters, difficultyOn: !filters.difficultyOn })
        }
        onChange={(v) => onChange({ ...filters, difficulty: v })}
        accent="var(--gold)"
      />

      <p className="match-count">
        {matchCount} tune{matchCount === 1 ? "" : "s"} in the deck
      </p>
    </section>
  );
}
