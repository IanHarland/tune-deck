import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
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

// pdf.js is heavy — only load the viewer when a book is actually opened.
const FakebookViewer = lazy(() => import("./FakebookViewer"));

// forScore is Apple-only; the single-page share needs the Web Share (files) API,
// which on Apple platforms means iOS/iPadOS Safari (and macOS). Show the button
// only where it can work.
const IS_APPLE =
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1));
const FORSCORE_SUPPORTED = IS_APPLE && typeof navigator !== "undefined" && !!navigator.share;

interface ViewTarget {
  slug: string;
  page: number; // pdf page (offset-adjusted)
  book: string;
  label: string; // printed page
}

type Pending =
  | ({ action: "read" } & ViewTarget)
  | { action: "forscore"; slug: string; book: string; printed: number; title?: string };

interface ForScoreParams {
  slug: string;
  book: string;
  printed: number;
  title?: string;
}

interface Ctx {
  canOpen: (book: string) => boolean; // configured + PDF present
  openChart: (book: string, printedPage: string | number) => void; // our reader
  openInForScore: (book: string, printedPage: string | number, title?: string) => void;
  forScoreSupported: boolean;
}

const FakebookCtx = createContext<Ctx>({
  canOpen: () => false,
  openChart: () => {},
  openInForScore: () => {},
  forScoreSupported: false,
});

// eslint-disable-next-line react-refresh/only-export-components
export const useFakebook = () => useContext(FakebookCtx);

const cleanName = (s: string) => (s || "").replace(/[/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();

// Owns fake-book auth + the reader + the forScore hand-off. Chart taps (search +
// main card) call openChart()/openInForScore(); if the device isn't unlocked yet
// it prompts for the password once (year-long cookie), then runs the pending
// action. Invisible to anyone without the feature configured.
export function FakebookProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<FakebookMeta | null>(null);
  const [viewer, setViewer] = useState<ViewTarget | null>(null); // reader open
  const [pending, setPending] = useState<Pending | null>(null); // awaiting password
  const [pw, setPw] = useState("");
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

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

  // hand one tune's page(s) to forScore via the iOS share sheet
  const shareToForScore = useCallback(async (p: ForScoreParams) => {
    try {
      const res = await fetch(fakebookTuneUrl(p.slug, p.printed));
      if (res.status === 401) {
        setMeta((m) => (m ? { ...m, authed: false } : m));
        setPending({ action: "forscore", ...p });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const fname = `${cleanName(p.title || p.book)} (${cleanName(p.book)} p${p.printed}).pdf`;
      const file = new File([blob], fname, { type: "application/pdf" });
      if (navigator.canShare && !navigator.canShare({ files: [file] })) {
        throw new Error("cant-share-files");
      }
      await navigator.share({ files: [file], title: p.title || p.book });
    } catch (e) {
      if ((e as Error).name === "AbortError") return; // user dismissed the sheet
      // fallback: open the page PDF so the user can share/save it manually
      try {
        window.open(fakebookTuneUrl(p.slug, p.printed), "_blank");
      } catch {
        /* popup blocked — nothing else to do */
      }
    }
  }, []);

  const openChart = useCallback(
    (book: string, printedPage: string | number) => {
      const info = meta?.books[book];
      if (!meta?.configured || !info?.available) return;
      const printed =
        typeof printedPage === "number" ? printedPage : parseInt(printedPage, 10);
      const pdfPage = Number.isFinite(printed) ? Math.max(1, printed + info.offset) : 1;
      const t: ViewTarget = { slug: info.slug, page: pdfPage, book, label: String(printedPage) };
      if (meta.authed) setViewer(t);
      else setPending({ action: "read", ...t });
    },
    [meta],
  );

  const openInForScore = useCallback(
    (book: string, printedPage: string | number, title?: string) => {
      const info = meta?.books[book];
      if (!meta?.configured || !info?.available) return;
      const printed =
        typeof printedPage === "number" ? printedPage : parseInt(printedPage, 10);
      if (!Number.isFinite(printed)) return;
      const p: ForScoreParams = { slug: info.slug, book, printed, title };
      if (meta.authed) shareToForScore(p);
      else setPending({ action: "forscore", ...p });
    },
    [meta, shareToForScore],
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
      if (p?.action === "forscore") shareToForScore(p);
      else if (p) {
        const { action, ...v } = p;
        void action;
        setViewer(v);
      }
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
    <FakebookCtx.Provider
      value={{ canOpen, openChart, openInForScore, forScoreSupported: FORSCORE_SUPPORTED }}
    >
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

      {viewer && (
        <Suspense
          fallback={
            <div className="fb-overlay">
              <div className="fb-msg">Opening book…</div>
            </div>
          }
        >
          <FakebookViewer {...viewer} onClose={() => setViewer(null)} />
        </Suspense>
      )}
    </FakebookCtx.Provider>
  );
}
