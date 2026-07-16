import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  authFakebook,
  fakebookTuneUrl,
  getFakebookMeta,
  type FakebookMeta,
} from "../core/fakebooks";

interface ChartParams {
  slug: string;
  book: string;
  printed: number;
  title?: string;
}

interface Ctx {
  canOpen: (book: string) => boolean; // configured + PDF present
  openChart: (book: string, printedPage: string | number, title?: string) => void;
  // Warm the tune PDF on pointerdown so the tap opens it promptly.
  prefetchChart: (book: string, printedPage: string | number) => void;
  isOpening: (book: string, printedPage: string | number) => boolean;
}

const FakebookCtx = createContext<Ctx>({
  canOpen: () => false,
  openChart: () => {},
  prefetchChart: () => {},
  isOpening: () => false,
});

// eslint-disable-next-line react-refresh/only-export-components
export const useFakebook = () => useContext(FakebookCtx);

const cleanName = (s: string) =>
  (s || "").replace(/[/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();

const chartKey = (slug: string, printed: number) => `${slug}:${printed}`;

// Open one tune's page(s) as its own PDF so the OS renders it in a Safari view
// (SFSafariViewController on iOS). That view's Share button is a document-
// interaction share on a real PDF, which offers "Copy to forScore" — the Web
// Share sheet never does (forScore ships no share extension). We hand over the
// already-fetched blob so the new view needs no re-auth.
function openPdfBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Owns fake-book auth + opening a chart. Tapping a chart (search or main card)
// calls openChart(); if the device isn't unlocked it prompts for the password
// once (year-long cookie), then opens. The chart opens as a standalone PDF page
// you can share straight into forScore. Invisible unless the feature is
// configured and the book's PDF is present.
export function FakebookProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<FakebookMeta | null>(null);
  const [pending, setPending] = useState<ChartParams | null>(null); // awaiting password
  const [opening, setOpening] = useState<string | null>(null); // chartKey being fetched
  const [pw, setPw] = useState("");
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  // in-flight/warmed tune-PDF fetches, keyed by `${slug}:${printed}`.
  const fsCache = useRef<Map<string, Promise<Blob>>>(new Map());

  useEffect(() => {
    getFakebookMeta()
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);

  const canOpen = useCallback(
    (book: string) => {
      const info = meta?.books[book];
      return !!(meta?.configured && info?.available);
    },
    [meta],
  );

  // start (and cache) the tune-PDF fetch; a rejected fetch is evicted so a later
  // tap can retry. 401 rejects too — the tap then falls into the password path.
  const fetchTune = useCallback((slug: string, printed: number): Promise<Blob> => {
    const key = chartKey(slug, printed);
    let p = fsCache.current.get(key);
    if (!p) {
      p = fetch(fakebookTuneUrl(slug, printed)).then((res) => {
        if (!res.ok) throw new Error(res.status === 401 ? "unauthorized" : String(res.status));
        return res.blob();
      });
      p.catch(() => fsCache.current.delete(key));
      fsCache.current.set(key, p);
    }
    return p;
  }, []);

  const prefetchChart = useCallback(
    (book: string, printedPage: string | number) => {
      const info = meta?.books[book];
      if (!meta?.configured || !info?.available || !meta.authed) return;
      const printed =
        typeof printedPage === "number" ? printedPage : parseInt(printedPage, 10);
      if (!Number.isFinite(printed)) return;
      fetchTune(info.slug, printed).catch(() => {}); // swallow — real errors surface on tap
    },
    [meta, fetchTune],
  );

  const openTunePdf = useCallback(
    async (p: ChartParams) => {
      const key = chartKey(p.slug, p.printed);
      setOpening(key);
      let blob: Blob;
      try {
        blob = await fetchTune(p.slug, p.printed);
      } catch (e) {
        setOpening(null);
        if ((e as Error).message === "unauthorized") {
          setMeta((m) => (m ? { ...m, authed: false } : m));
          setPending(p);
        }
        return; // couldn't fetch the page — nothing to open
      }
      const fname = `${cleanName(p.title || p.book)} (${cleanName(p.book)} p${p.printed}).pdf`;
      openPdfBlob(blob, fname);
      setOpening(null);
    },
    [fetchTune],
  );

  const openChart = useCallback(
    (book: string, printedPage: string | number, title?: string) => {
      const info = meta?.books[book];
      if (!meta?.configured || !info?.available) return;
      const printed =
        typeof printedPage === "number" ? printedPage : parseInt(printedPage, 10);
      if (!Number.isFinite(printed)) return;
      const p: ChartParams = { slug: info.slug, book, printed, title };
      if (meta.authed) openTunePdf(p);
      else setPending(p);
    },
    [meta, openTunePdf],
  );

  const isOpening = useCallback(
    (book: string, printedPage: string | number) => {
      const info = meta?.books[book];
      if (!info || !opening) return false;
      const printed =
        typeof printedPage === "number" ? printedPage : parseInt(printedPage, 10);
      return opening === chartKey(info.slug, printed);
    },
    [meta, opening],
  );

  async function submitPw(e: FormEvent) {
    e.preventDefault();
    if (!pw || authBusy) return;
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await authFakebook(pw);
      setMeta((m) => (m ? { ...m, authed: true } : m));
      const p = pending;
      setPending(null);
      setPw("");
      if (p) openTunePdf(p);
    } catch (err) {
      const msg = (err as Error).message;
      setAuthErr(
        msg === "wrong-password"
          ? "Wrong password."
          : msg === "not-configured"
            ? "Reader isn’t set up yet."
            : "Couldn’t sign in — try again.",
      );
    } finally {
      setAuthBusy(false);
    }
  }

  function cancelPw() {
    setPending(null);
    setPw("");
    setAuthErr(null);
  }

  return (
    <FakebookCtx.Provider value={{ canOpen, openChart, prefetchChart, isOpening }}>
      {children}

      {pending && (
        <div
          className="fb-overlay fb-auth"
          role="dialog"
          aria-modal="true"
          aria-label="Enter fake-book password"
          onClick={cancelPw}
        >
          <form className="fb-auth-card" onClick={(e) => e.stopPropagation()} onSubmit={submitPw}>
            <h2 className="fb-auth-title">Open the fake book</h2>
            <p className="fb-auth-sub">Enter the password once — this device stays unlocked.</p>
            <input
              className="fb-auth-input"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Password"
              autoFocus
              autoComplete="current-password"
            />
            {authErr && <p className="fb-auth-err">{authErr}</p>}
            <div className="fb-auth-actions">
              <button type="button" className="fb-auth-cancel" onClick={cancelPw}>
                Cancel
              </button>
              <button type="submit" className="fb-auth-go" disabled={authBusy || !pw}>
                {authBusy ? "…" : "Unlock"}
              </button>
            </div>
          </form>
        </div>
      )}
    </FakebookCtx.Provider>
  );
}
