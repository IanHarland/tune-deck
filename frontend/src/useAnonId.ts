// Web-only: a stable anonymous id so a user's weigh-ins can be attributed
// without a login. (A native app would use expo-secure-store instead — this is
// intentionally kept out of core/.)
import { useEffect, useState } from "react";

const KEY = "tunedeck_anon_id";

// A v4 UUID that also works on Safari < 15.4 (which lacks crypto.randomUUID) and
// even where WebCrypto is missing entirely. Calling crypto.randomUUID directly
// throws on an old iPad (Safari 14) and blanks the whole app, so we degrade.
function makeId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      /* fall through to getRandomValues */
    }
  }
  if (c?.getRandomValues) {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    const h: string[] = [];
    for (let i = 0; i < 16; i++) h.push(b[i].toString(16).padStart(2, "0"));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
  }
  // No WebCrypto at all: not cryptographically strong, but fine for an
  // anonymous attribution id.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function useAnonId(): string {
  const [id, setId] = useState("");
  useEffect(() => {
    // localStorage can throw on old/private Safari — never let it blank the app.
    let v = "";
    try {
      v = localStorage.getItem(KEY) || "";
      if (!v) {
        v = makeId();
        localStorage.setItem(KEY, v);
      }
    } catch {
      if (!v) v = makeId(); // ephemeral id for this session
    }
    setId(v);
  }, []);
  return id;
}
