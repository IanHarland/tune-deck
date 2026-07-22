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
  canOpenPage,
  fakebookTuneUrl,
  getFakebookMeta,
  pageToken,
  type FakebookMeta,
} from "../core/fakebooks";

interface ChartParams {
  slug: string;
  book: string;
  page: string; // printed page as the book prints it — "288" or "A1"
  title?: string;
}

interface Ctx {
  // configured + PDF present + this page is one we can locate in that PDF
  canOpen: (book: string, printedPage: string | number) => boolean;
  openChart: (book: string, printedPage: string | number, title?: string) => void;
  // Warm the tune PDF on pointerdown so the tap opens it promptly.
  prefetchChart: (book: string, printedPage: string | number) => void;
  isOpening: (book: string, printedPage: string | number) => boolean;
  // the fetch came back with something other than the chart (e.g. the index
  // points at a page the book doesn't have) — the row says so instead of
  // swallowing it.
  didFail: (book: string, printedPage: string | number) => boolean;
}

const FakebookCtx = createContext<Ctx>({
  canOpen: () => false,
  openChart: () => {},
  prefetchChart: () => {},
  isOpening: () => false,
  didFail: () => false,
});

// eslint-disable-next-line react-refresh/only-export-components
export const useFakebook = () => useContext(FakebookCtx);

const cleanName = (s: string) =>
  (s || "").replace(/[/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();

const chartKey = (slug: string, page: string) => `${slug}:${page}`;

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
  const [failed, setFailed] = useState<Set<string>>(new Set()); // chartKeys that errored
  const [pw, setPw] = useState("");
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  // in-flight/warmed tune-PDF fetches, keyed by `${slug}:${page}`.
  const fsCache = useRef<Map<string, Promise<Blob>>>(new Map());

  useEffect(() => {
    getFakebookMeta()
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);

  const canOpen = useCallback(
    (book: string, printedPage: string | number) =>
      !!meta?.configured && canOpenPage(meta.books[book], printedPage),
    [meta],
  );

  // start (and cache) the tune-PDF fetch; a rejected fetch is evicted so a later
  // tap can retry. 401 rejects too — the tap then falls into the password path.
  const fetchTune = useCallback((slug: string, page: string): Promise<Blob> => {
    const key = chartKey(slug, page);
    let p = fsCache.current.get(key);
    if (!p) {
      p = fetch(fakebookTuneUrl(slug, page)).then((res) => {
        if (!res.ok) throw new Error(res.status === 401 ? "unauthorized" : String(res.status));
        return res.blob();
      });
      p.catch(() => fsCache.current.delete(key));
      fsCache.current.set(key, p);
    }
    return p;
  }, []);

  // resolve a (book, page) pair to everything the fetch needs, or null if this
  // book can't open that page at all.
  const resolve = useCallback(
    (book: string, printedPage: string | number, title?: string): ChartParams | null => {
      const info = meta?.books[book];
      const page = pageToken(printedPage);
      if (!meta?.configured || !info || !page || !canOpenPage(info, page)) return null;
      return { slug: info.slug, book, page, title };
    },
    [meta],
  );

  const prefetchChart = useCallback(
    (book: string, printedPage: string | number) => {
      const p = resolve(book, printedPage);
      if (!p || !meta?.authed) return;
      fetchTune(p.slug, p.page).catch(() => {}); // swallow — real errors surface on tap
    },
    [meta, resolve, fetchTune],
  );

  const openTunePdf = useCallback(
    async (p: ChartParams) => {
      const key = chartKey(p.slug, p.page);
      setOpening(key);
      setFailed((f) => (f.has(key) ? new Set([...f].filter((k) => k !== key)) : f));
      let blob: Blob;
      try {
        blob = await fetchTune(p.slug, p.page);
      } catch (e) {
        setOpening(null);
        if ((e as Error).message === "unauthorized") {
          setMeta((m) => (m ? { ...m, authed: false } : m));
          setPending(p);
        } else {
          // e.g. 404 — the index cites a page this book doesn't have. Say so
          // rather than leaving the tap looking like it did nothing.
          setFailed((f) => new Set(f).add(key));
        }
        return; // couldn't fetch the page — nothing to open
      }
      const fname = `${cleanName(p.title || p.book)} (${cleanName(p.book)} p${p.page}).pdf`;
      openPdfBlob(blob, fname);
      setOpening(null);
    },
    [fetchTune],
  );

  const openChart = useCallback(
    (book: string, printedPage: string | number, title?: string) => {
      const p = resolve(book, printedPage, title);
      if (!p) return;
      if (meta?.authed) openTunePdf(p);
      else setPending(p);
    },
    [meta, resolve, openTunePdf],
  );

  const keyOf = useCallback(
    (book: string, printedPage: string | number) => {
      const info = meta?.books[book];
      const page = pageToken(printedPage);
      return info && page ? chartKey(info.slug, page) : null;
    },
    [meta],
  );

  const isOpening = useCallback(
    (book: string, printedPage: string | number) => !!opening && keyOf(book, printedPage) === opening,
    [keyOf, opening],
  );

  const didFail = useCallback(
    (book: string, printedPage: string | number) => {
      const key = keyOf(book, printedPage);
      return !!key && failed.has(key);
    },
    [keyOf, failed],
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
    <FakebookCtx.Provider value={{ canOpen, openChart, prefetchChart, isOpening, didFail }}>
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
