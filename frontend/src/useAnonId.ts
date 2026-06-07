// Web-only: a stable anonymous id so a user's weigh-ins can be attributed
// without a login. (A native app would use expo-secure-store instead — this is
// intentionally kept out of core/.)
import { useEffect, useState } from "react";

const KEY = "tunedeck_anon_id";

export function useAnonId(): string {
  const [id, setId] = useState("");
  useEffect(() => {
    let v = localStorage.getItem(KEY);
    if (!v) {
      v = crypto.randomUUID();
      localStorage.setItem(KEY, v);
    }
    setId(v);
  }, []);
  return id;
}
