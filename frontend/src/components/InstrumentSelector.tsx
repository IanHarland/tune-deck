import { INSTRUMENTS, type Instrument } from "../core/keys";

interface Props {
  instrument: Instrument;
  onChange: (id: string) => void;
}

export default function InstrumentSelector({ instrument, onChange }: Props) {
  return (
    <div className="instrument">
      <span className="instrument-label">Transposition</span>
      <div className="instrument-opts">
        {INSTRUMENTS.map((i) => (
          <button
            key={i.id}
            type="button"
            className={`inst-chip ${i.id === instrument.id ? "inst-on" : ""}`}
            onClick={() => onChange(i.id)}
          >
            {i.label}
          </button>
        ))}
      </div>
    </div>
  );
}
