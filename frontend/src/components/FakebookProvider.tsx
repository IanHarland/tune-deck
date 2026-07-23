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
  editionFor,
  fakebookTuneUrl,
  getFakebookMeta,
  pageToken,
  type FakebookMeta,
} from "../core/fakebooks";
import { getNotationIndex } from "../core/notation";

interface ChartParams {
  slug: string;
  book: string;
  page: string; // printed page as the book prints it — "288" or "A1"
  edition: string; // "" = concert, else "Bb"/"Eb" — the printing to open
  title?: string;
}

interface Ctx {
  // configured + PDF present + this page is one we can locate in that PDF
  canOpen: (book: string, printedPage: string | number) => boolean;
  // "" when this ref opens in concert pitch, else the transposed printing
  // ("Bb"/"Eb") the current instrument will actually get.
  editionOf: (book: string, printedPage: string | number) => string;
  // does this tune have a stored chart — i.e. is "Read in any key" worth
  // offering. Charts come from the server's charts/ folder, so this only ever
  // changes on deploy (or on unlock, since the index is behind the password).
  hasNotation: (tuneId: string) => boolean;
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
  editionOf: () => "",
  hasNotation: () => false,
  openChart: () => {},
  prefetchChart: () => {},
  isOpening: () => false,
  didFail: () => false,
});

// eslint-disable-next-line react-refresh/only-export-components
export const useFakebook = () => useContext(FakebookCtx);

const cleanName = (s: string) =>
  (s || "").replace(/[/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();

// The edition belongs in the key: the same book+page in B♭ and in concert are
// different PDFs, and without it the first one fetched would be served for both.
const chartKey = (slug: string, page: string, edition = "") =>
  `${slug}:${page}${edition ? `:${edition}` : ""}`;

// Key for a tap taken before meta arrived — keyed by book NAME (meta is what
// maps name -> slug), so it can't collide with a real chartKey.
const pendingKey = (book: string, page: string | number) => `pending:${book}:${page}`;

const META_CACHE = "tunedeck.fbmeta";

// Last known meta, used ONLY to decide whether a chart row LOOKS tappable
// before the live meta lands. Never used to open anything: `authed` reflects a
// cookie the server owns, so a tap always waits for the real answer.
function loadCachedMeta(): FakebookMeta | null {
  try {
    const m = JSON.parse(localStorage.getItem(META_CACHE) || "null");
    return m && m.books ? ({ ...m, authed: false } as FakebookMeta) : null;
  } catch {
    return null;
  }
}

function cacheMeta(m: FakebookMeta) {
  try {
    localStorage.setItem(META_CACHE, JSON.stringify({ configured: m.configured, books: m.books }));
  } catch {
    /* private mode — just means no optimistic hint next cold start */
  }
}

// Resolve a (book, page) against a KNOWN meta. Pulled out of the component so
// the cold-start path can resolve against a freshly awaited meta rather than
// the stale one captured in its closure.
function resolveWith(
  m: FakebookMeta | null,
  book: string,
  printedPage: string | number,
  edition: string,
  title?: string,
): ChartParams | null {
  const info = m?.books[book];
  const page = pageToken(printedPage);
  if (!m?.configured || !info || !page || !canOpenPage(info, page)) return null;
  return { slug: info.slug, book, page, edition: editionFor(info, page, edition), title };
}

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
export function FakebookProvider({
  children,
  edition = "C",
}: {
  children: ReactNode;
  /** The player's instrument ("C" | "Bb" | "Eb" | "F"). Books exist only for
   *  some of these on some titles; anything unstocked opens in concert. */
  edition?: string;
}) {
  const [meta, setMeta] = useState<FakebookMeta | null>(null);
  // Last session's answer, so rows can look right immediately on a cold start.
  const [hint] = useState<FakebookMeta | null>(loadCachedMeta);
  const [loading, setLoading] = useState(true); // meta fetch still in flight
  const metaPromise = useRef<Promise<FakebookMeta | null> | null>(null);
  const [pending, setPending] = useState<ChartParams | null>(null); // awaiting password
  const [opening, setOpening] = useState<string | null>(null); // chartKey being fetched
  const [failed, setFailed] = useState<Set<string>>(new Set()); // chartKeys that errored
  const [notated, setNotated] = useState<Set<string>>(new Set());
  const [pw, setPw] = useState("");
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  // in-flight/warmed tune-PDF fetches, keyed by `${slug}:${page}`.
  const fsCache = useRef<Map<string, Promise<Blob>>>(new Map());

  useEffect(() => {
    metaPromise.current = getFakebookMeta()
      .then(
        (m) => {
          setMeta(m);
          cacheMeta(m);
          return m;
        },
        () => {
          setMeta(null);
          return null;
        },
      )
      .finally(() => setLoading(false));
  }, []);

  // The index is password-gated, so it comes back empty until unlocked — refetch
  // when auth flips rather than leaving every transpose button hidden.
  const authed = !!meta?.authed;
  useEffect(() => {
    if (!authed) {
      setNotated(new Set());
      return;
    }
    let live = true;
    getNotationIndex()
      .then((ids) => live && setNotated(ids))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [authed]);

  const hasNotation = useCallback((tuneId: string) => notated.has(tuneId), [notated]);

  // Optimistic while the meta request is in flight. The API scales to zero, so
  // a cold wake takes 15–20 s, and rows that will plainly be buttons a moment
  // later shouldn't read as dead text until then — a tap during the wake is
  // held and opened when meta arrives (see openChart), not dropped. Prefer
  // last session's cached answer; with no cache, assume openable. Once the real
  // meta lands it wins, so a book that isn't stocked settles back to plain text.
  const canOpen = useCallback(
    (book: string, printedPage: string | number) => {
      if (meta) return !!meta.configured && canOpenPage(meta.books[book], printedPage);
      if (hint) return !!hint.configured && canOpenPage(hint.books[book], printedPage);
      return loading;
    },
    [meta, hint, loading],
  );

  const editionOf = useCallback(
    (book: string, printedPage: string | number) =>
      editionFor((meta ?? hint)?.books[book], printedPage, edition),
    [meta, hint, edition],
  );

  // start (and cache) the tune-PDF fetch; a rejected fetch is evicted so a later
  // tap can retry. 401 rejects too — the tap then falls into the password path.
  const fetchTune = useCallback((slug: string, page: string, ed: string): Promise<Blob> => {
    const key = chartKey(slug, page, ed);
    let p = fsCache.current.get(key);
    if (!p) {
      p = fetch(fakebookTuneUrl(slug, page, ed)).then((res) => {
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
    (book: string, printedPage: string | number, title?: string): ChartParams | null =>
      resolveWith(meta, book, printedPage, edition, title),
    [meta, edition],
  );

  const prefetchChart = useCallback(
    (book: string, printedPage: string | number) => {
      const p = resolve(book, printedPage);
      if (!p || !meta?.authed) return;
      fetchTune(p.slug, p.page, p.edition).catch(() => {}); // swallow — real errors surface on tap
    },
    [meta, resolve, fetchTune],
  );

  const openTunePdf = useCallback(
    async (p: ChartParams) => {
      const key = chartKey(p.slug, p.page, p.edition);
      setOpening(key);
      setFailed((f) => (f.has(key) ? new Set([...f].filter((k) => k !== key)) : f));
      let blob: Blob;
      try {
        blob = await fetchTune(p.slug, p.page, p.edition);
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
      const suffix = p.edition ? ` ${p.edition}` : "";
      const fname = `${cleanName(p.title || p.book)} (${cleanName(p.book)} p${p.page}${suffix}).pdf`;
      openPdfBlob(blob, fname);
      setOpening(null);
    },
    [fetchTune],
  );

  const openChart = useCallback(
    (book: string, printedPage: string | number, title?: string) => {
      if (meta) {
        const p = resolve(book, printedPage, title);
        if (!p) return;
        if (meta.authed) openTunePdf(p);
        else setPending(p);
        return;
      }
      // Tapped during the cold-start wake. Spin on this row and open the moment
      // meta lands — the tap is queued, not lost. Once meta is set, keyOf()
      // computes the real chartKey and openTunePdf re-keys the spinner to it.
      const key = pendingKey(book, printedPage);
      setOpening(key);
      setFailed((f) => (f.has(key) ? new Set([...f].filter((k) => k !== key)) : f));
      const wait = metaPromise.current ?? Promise.resolve(null);
      wait
        .then((m) => {
          const p = resolveWith(m, book, printedPage, edition, title);
          if (!p) {
            // Either the reader isn't configured or this book isn't stocked —
            // the row is about to become plain text, so just stop spinning.
            setOpening(null);
            return;
          }
          if (m?.authed) openTunePdf(p);
          else {
            setOpening(null);
            setPending(p);
          }
        })
        .catch(() => {
          setOpening(null);
          setFailed((f) => new Set(f).add(key));
        });
    },
    [meta, edition, resolve, openTunePdf],
  );

  const keyOf = useCallback(
    (book: string, printedPage: string | number) => {
      const page = pageToken(printedPage);
      // Before meta arrives there's no slug to key by — match the provisional
      // key openChart used, so the spinner shows on the row that was tapped.
      if (!meta) return pendingKey(book, printedPage);
      const info = meta.books[book];
      return info && page ? chartKey(info.slug, page, editionFor(info, page, edition)) : null;
    },
    [meta, edition],
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
    <FakebookCtx.Provider
      value={{ canOpen, editionOf, hasNotation, openChart, prefetchChart, isOpening, didFail }}
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
    </FakebookCtx.Provider>
  );
}
