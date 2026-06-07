// Render a key string with the accidental as a proper superscript symbol:
// "Gb" -> G♭, "F#" -> F♯, "Eb-" -> E♭- (minor marker preserved).

interface Props {
  k: string | null | undefined;
}

export default function KeyLabel({ k }: Props) {
  if (!k) return <>—</>;
  const m = k.match(/^([A-Ga-g])([b#]?)(.*)$/);
  if (!m) return <>{k}</>;
  const [, root, acc, rest] = m;
  return (
    <>
      {root.toUpperCase()}
      {acc && <sup className="acc">{acc === "b" ? "♭" : "♯"}</sup>}
      {rest}
    </>
  );
}
