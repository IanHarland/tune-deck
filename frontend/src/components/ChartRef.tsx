import { coverSlug } from "../core/covers";
import type { ChartRef as ChartRefT } from "../core/types";
import { useFakebook } from "./FakebookProvider";

// One fake-book reference: cover thumbnail + book + printed page. When the
// private reader is configured for that book the whole row is one tap target —
// tapping opens just this tune's page(s) as a standalone PDF, ready to share
// into forScore. A spinner shows while the page is being fetched (the extract
// can take a few seconds cold). Otherwise it's plain, non-interactive text.
export default function ChartRef({ chart, title }: { chart: ChartRefT; title?: string }) {
  const { canOpen, openChart, prefetchChart, isOpening, didFail } = useFakebook();
  const openable = canOpen(chart.book, chart.page);
  const loading = openable && isOpening(chart.book, chart.page);
  const failed = openable && !loading && didFail(chart.book, chart.page);
  const open = () => openChart(chart.book, chart.page, title);

  return (
    <li
      className={`chart-ref${openable ? " chart-open" : ""}${loading ? " chart-loading" : ""}`}
      onClick={openable ? open : undefined}
      // warm the PDF on press so the tap opens it with less delay
      onPointerDown={openable ? () => prefetchChart(chart.book, chart.page) : undefined}
      role={openable ? "button" : undefined}
      tabIndex={openable ? 0 : undefined}
      aria-busy={loading || undefined}
      onKeyDown={
        openable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            }
          : undefined
      }
      title={
        failed
          ? `${chart.book} has no p.${chart.page} — the index reference looks wrong`
          : openable
            ? `Open ${chart.book} at p.${chart.page}`
            : undefined
      }
    >
      <img
        className="chart-cover"
        src={`/covers/${coverSlug(chart.book)}.jpg`}
        alt=""
        loading="lazy"
        onError={(e) => {
          e.currentTarget.style.visibility = "hidden";
        }}
      />
      <span className="chart-book">{chart.book}</span>
      <span className="chart-page">p.{chart.page}</span>
      {openable && (
        <span className={`chart-open-hint${failed ? " chart-failed" : ""}`} aria-hidden>
          {loading ? <span className="chart-spinner" /> : failed ? "!" : "›"}
        </span>
      )}
    </li>
  );
}
