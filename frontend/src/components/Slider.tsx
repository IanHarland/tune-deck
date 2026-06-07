interface Props {
  value: number;
  onChange: (v: number) => void;
  leftLabel: string;
  rightLabel: string;
  label: string;
  accent?: string;
  enabled?: boolean; // when an onToggle is provided
  onToggle?: () => void;
}

export default function Slider({
  value,
  onChange,
  leftLabel,
  rightLabel,
  label,
  accent = "var(--gold)",
  enabled = true,
  onToggle,
}: Props) {
  return (
    <div className={`slider ${enabled ? "" : "slider-off"}`}>
      <div className="slider-head">
        <span className="slider-label">{label}</span>
        {onToggle ? (
          <button
            type="button"
            className={`slider-toggle ${enabled ? "on" : "off"}`}
            onClick={onToggle}
          >
            {enabled ? Math.round(value) : "off"}
          </button>
        ) : (
          <span className="slider-value">{Math.round(value)}</span>
        )}
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        disabled={!enabled}
        style={{ accentColor: accent }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="slider-ends">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  );
}
