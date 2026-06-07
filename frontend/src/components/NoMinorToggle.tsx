import { useRef } from "react";

interface Props {
  on: boolean;
  onChange: (on: boolean) => void;
}

// "prove it" voice clips — cycled in order, one per switch INTO no-minor mode
const CLIPS = ["/prove-it-1.m4a", "/prove-it-2.m4a", "/prove-it-3.m4a", "/prove-it-4.m4a"];

// "no minor" — an italic i in a circle; when on, a red prohibition slash crosses
// it. Toggling shows minor keys as their relative major.
export default function NoMinorToggle({ on, onChange }: Props) {
  const next = useRef(0); // which clip plays next
  const audio = useRef<HTMLAudioElement | null>(null);

  function toggle() {
    const turningOn = !on;
    if (turningOn) {
      const clip = new Audio(CLIPS[next.current % CLIPS.length]);
      next.current += 1;
      audio.current = clip;
      clip.play().catch(() => {}); // user gesture, but ignore any block
    } else if (audio.current) {
      // toggling back to normal cancels the clip
      audio.current.pause();
      audio.current = null;
    }
    onChange(turningOn);
  }
  return (
    <button
      type="button"
      className={`nominor ${on ? "nominor-on" : ""}`}
      onClick={toggle}
      aria-pressed={on}
      title={on ? "Minor keys shown as relative major" : "Show minor keys as relative major"}
    >
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden>
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
        <text
          x="12"
          y="16.5"
          textAnchor="middle"
          fontFamily="Georgia, 'Times New Roman', serif"
          fontWeight="700"
          fontSize="13"
          fill="var(--cream)"
        >
          i
        </text>
        {on && <line x1="5" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2" />}
      </svg>
    </button>
  );
}
