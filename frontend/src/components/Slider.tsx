interface Props {
  value: number;
  onChange: (v: number) => void;
  leftLabel: string;
  rightLabel: string;
  label: string;
  accent?: string;
}

export default function Slider({
  value,
  onChange,
  leftLabel,
  rightLabel,
  label,
  accent = "var(--gold)",
}: Props) {
  return (
    <div className="slider">
      <div className="slider-head">
        <span className="slider-label">{label}</span>
        <span className="slider-value">{Math.round(value)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
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
