import { coverSlug } from "../core/covers";
import type { ChartRef as ChartRefT } from "../core/types";
import { useFakebook } from "./FakebookProvider";

// One fake-book reference: cover thumbnail + book + printed page. Tappable when
// the private reader is available for that book (opens the PDF at this page);
// otherwise it renders as plain text, exactly as before.
export default function ChartRef({ chart }: { chart: ChartRefT }) {
  const { canOpen, openChart } = useFakebook();
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
      {openable && (
        <span className="chart-open-hint" aria-hidden>
          ›
        </span>
      )}
    </li>
  );
}
