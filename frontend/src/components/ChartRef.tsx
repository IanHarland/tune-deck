import { coverSlug } from "../core/covers";
import type { ChartRef as ChartRefT } from "../core/types";
import { useFakebook } from "./FakebookProvider";

// One fake-book reference: cover thumbnail + book + printed page. Tappable when
// the private reader is available for that book (opens the PDF at this page);
// otherwise it renders as plain text, exactly as before. On Apple devices a
// small "forScore" button hands just this tune's page(s) to forScore.
export default function ChartRef({ chart, title }: { chart: ChartRefT; title?: string }) {
  const { canOpen, openChart, openInForScore, forScoreSupported } = useFakebook();
  const openable = canOpen(chart.book);
  const open = () => openChart(chart.book, chart.page);

  return (
    <li
      className={`chart-ref${openable ? " chart-open" : ""}`}
      onClick={openable ? open : undefined}
      role={openable ? "button" : undefined}
      tabIndex={openable ? 0 : undefined}
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
      title={openable ? `Open ${chart.book} at p.${chart.page}` : undefined}
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
      {openable && forScoreSupported && (
        <button
          className="fs-btn"
          onClick={(e) => {
            e.stopPropagation();
            openInForScore(chart.book, chart.page, title);
          }}
          aria-label="Open this tune's page in forScore"
          title="Open this tune's page in forScore"
        >
          forScore
        </button>
      )}
      {openable && !forScoreSupported && (
        <span className="chart-open-hint" aria-hidden>
          ›
        </span>
      )}
    </li>
  );
}
