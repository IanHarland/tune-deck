import { useEffect, useMemo, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { fakebookPdfUrl } from "../core/fakebooks";

// Bundle the pdf.js worker through Vite (resolves to a hashed asset URL).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

// Don't prefetch the whole file (books run ~15–100 MB) — pull only the viewed
// pages via HTTP Range (the Flask route supports it). Module-const so <Document>
// doesn't see a fresh object each render and reload.
const PDF_OPTIONS = { disableAutoFetch: true, disableStream: false };

interface Props {
  slug: string;
  page: number; // PDF page to open at (already offset-adjusted)
  book: string; // display name, for the header
  label: string; // printed page number, for the header
  onClose: () => void;
}

// Full-screen reader for one fake book, opened at a tune's page. Works on iOS
// because pdf.js renders to a canvas (no reliance on the native #page viewer).
export default function FakebookViewer({ slug, page, book, label, onClose }: Props) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNum, setPageNum] = useState(page);
  const [width, setWidth] = useState(fitWidth);
  const [failed, setFailed] = useState(false);

  const fileUrl = useMemo(() => fakebookPdfUrl(slug), [slug]);

  // opening a different chart resets the view
  useEffect(() => {
    setPageNum(page);
    setNumPages(null);
    setFailed(false);
  }, [slug, page]);

  // fit page to viewport; re-fit on resize / orientation change
  useEffect(() => {
    const onResize = () => setWidth(fitWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Esc closes; arrows page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setPageNum((p) => clamp(p + 1, numPages));
      else if (e.key === "ArrowLeft") setPageNum((p) => clamp(p - 1, numPages));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [numPages, onClose]);

  const canPrev = pageNum > 1;
  const canNext = numPages == null || pageNum < numPages;

  return (
    <div
      className="fb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${book}, page ${label}`}
    >
      <div className="fb-bar">
        <button className="fb-close" onClick={onClose} aria-label="Close book">
          ✕
        </button>
        <span className="fb-book" title={book}>
          {book}
        </span>
        <div className="fb-nav">
          <button
            onClick={() => setPageNum((p) => clamp(p - 1, numPages))}
            disabled={!canPrev}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span className="fb-page">
            p.{pageNum}
            {numPages ? ` / ${numPages}` : ""}
          </span>
          <button
            onClick={() => setPageNum((p) => clamp(p + 1, numPages))}
            disabled={!canNext}
            aria-label="Next page"
          >
            ›
          </button>
        </div>
      </div>

      <div className="fb-scroll">
        {failed ? (
          <div className="fb-msg">Couldn’t load this book.</div>
        ) : (
          <Document
            file={fileUrl}
            options={PDF_OPTIONS}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            onLoadError={() => setFailed(true)}
            loading={<div className="fb-msg">Opening book…</div>}
            error={<div className="fb-msg">Couldn’t load this book.</div>}
          >
            <Page
              pageNumber={clamp(pageNum, numPages)}
              width={width}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              loading={<div className="fb-msg">Rendering page…</div>}
            />
          </Document>
        )}
      </div>
    </div>
  );
}

function fitWidth(): number {
  const w = typeof window !== "undefined" ? window.innerWidth : 800;
  return Math.min(w - 16, 1000);
}

function clamp(p: number, max: number | null): number {
  const lo = Math.max(1, p);
  return max ? Math.min(max, lo) : lo;
}
