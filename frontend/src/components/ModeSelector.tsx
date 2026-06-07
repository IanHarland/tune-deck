import { MODE_LABELS, type Mode } from "../core/types";

interface Props {
  mode: Mode;
  onChange: (m: Mode) => void;
}

const MODES = Object.keys(MODE_LABELS) as Mode[];

export default function ModeSelector({ mode, onChange }: Props) {
  return (
    <div className="mode">
      <span className="mode-label">Mode</span>
      <select
        className={`mode-select ${mode !== "normal" ? "mode-active" : ""}`}
        value={mode}
        onChange={(e) => onChange(e.target.value as Mode)}
      >
        {MODES.map((m) => (
          <option key={m} value={m}>
            {MODE_LABELS[m]}
          </option>
        ))}
      </select>
    </div>
  );
}
