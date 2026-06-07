// Web-only: remember the user's instrument transposition across sessions.
import { useEffect, useState } from "react";
import { INSTRUMENTS, type Instrument } from "./core/keys";

const KEY = "tunedeck_instrument";

export function useInstrument(): [Instrument, (id: string) => void] {
  const [id, setId] = useState("C");

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved && INSTRUMENTS.some((i) => i.id === saved)) setId(saved);
  }, []);

  const set = (next: string) => {
    setId(next);
    localStorage.setItem(KEY, next);
  };

  const instrument = INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0];
  return [instrument, set];
}
