import type { Suit as SuitName } from "../core/keys";

interface Props {
  suit: SuitName;
  color: "red" | "black";
  size?: number;
}

// Renders one of the Anglo-American suit SVGs, recolored via CSS mask so sharps
// can be red and flats black regardless of the source art's color.
export default function Suit({ suit, color, size = 16 }: Props) {
  return (
    <span
      className="suit"
      style={{
        width: size,
        height: size,
        WebkitMaskImage: `url(/Suits/${suit}.svg)`,
        maskImage: `url(/Suits/${suit}.svg)`,
        backgroundColor: color === "red" ? "var(--card-red)" : "var(--card-black)",
      }}
    />
  );
}
