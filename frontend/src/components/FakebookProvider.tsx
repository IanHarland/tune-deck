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
import { authFakebook, getFakebookMeta, type FakebookMeta } from "../core/fakebooks";

// pdf.js is heavy — only load the viewer when a book is actually opened.
const FakebookViewer = lazy(() => import("./FakebookViewer"));

interface Target {
  slug: string;
  page: number; // PDF page (offset-adjusted)
  book: string;
  label: string; // printed page, for the header
}

interface Ctx {
  canOpen: (book: string) => boolean; // configured + PDF present
  openChart: (book: string, printedPage: string | number) => void;
}

const FakebookCtx = createContext<Ctx>({ canOpen: () => false, openChart: () => {} });

// eslint-disable-next-line react-refresh/only-export-components
export const useFakebook = () => useContext(FakebookCtx);

// Owns fake-book auth + the reader. Chart taps (search + main card) call
// openChart(); if the device isn't unlocked yet it prompts for the password
// once (then a year-long cookie keeps it open). Invisible to anyone without the
// feature configured — canOpen() is false, so charts stay plain text.
export function FakebookProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<FakebookMeta | null>(null);
  const [target, setTarget] = useState<Target | null>(null); // reader open
  const [pending, setPending] = useState<Target | null>(null); // awaiting password
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

  const openChart = useCallback(
    (book: string, printedPage: string | number) => {
      const info = meta?.books[book];
      if (!meta?.configured || !info?.available) return;
      const printed =
        typeof printedPage === "number" ? printedPage : parseInt(printedPage, 10);
      const pdfPage = Number.isFinite(printed) ? Math.max(1, printed + info.offset) : 1;
      const t: Target = { slug: info.slug, page: pdfPage, book, label: String(printedPage) };
      if (meta.authed) setTarget(t);
      else setPending(t); // prompt for the password, then open
    },
    [meta],
  );

  async function submitPw(e: FormEvent) {
    e.preventDefault();
    if (!pw || authBusy) return;
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await authFakebook(pw);
      setMeta((m) => (m ? { ...m, authed: true } : m));
      const t = pending;
      setPending(null);
      setPw("");
      if (t) setTarget(t);
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
    <FakebookCtx.Provider value={{ canOpen, openChart }}>
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

      {target && (
        <Suspense
          fallback={
            <div className="fb-overlay">
              <div className="fb-msg">Opening book…</div>
            </div>
          }
        >
          <FakebookViewer {...target} onClose={() => setTarget(null)} />
        </Suspense>
      )}
    </FakebookCtx.Provider>
  );
}
