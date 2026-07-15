import { useEffect, useState } from "react";
import { deleteTune, markPlayed, randomizeKey } from "../core/api";
import { coverSlug } from "../core/covers";
import { irealUrlFor } from "../core/irealLink";
import type { Tune } from "../core/types";

interface Props {
  tune: Tune;
  currentKey: string | null; // concert key currently shown (randomized or original)
  onUpdate: (t: Tune) => void;
  onDelete: (id: string) => void;
  onRandomized: (key: string) => void;
}

// Obscurity/difficulty weigh-in now lives on the card (the draggable pills);
// this strip is the per-tune actions: key, play tracking, charts, delete.
export default function ResultControls({
  tune,
  currentKey,
  onUpdate,
  onDelete,
  onRandomized,
}: Props) {
  const [busyKey, setBusyKey] = useState(false);
  const [playedBusy, setPlayedBusy] = useState(false);
  const [played, setPlayed] = useState(false); // logged this card once already
  const [deleting, setDeleting] = useState(false);

  // reset transient state when a new tune is drawn
  useEffect(() => {
    setDeleting(false);
    setBusyKey(false);
    setPlayedBusy(false);
    setPlayed(false);
  }, [tune.id]);

  async function onPlayed() {
    if (played || playedBusy) return; // one log per tune
    setPlayedBusy(true);
    try {
      // record the key it was actually played in (whatever's on screen)
      onUpdate(await markPlayed(tune.id, currentKey));
      setPlayed(true);
    } catch (e) {
      console.error(e);
    } finally {
      setPlayedBusy(false);
    }
  }

  async function onRandomize() {
    setBusyKey(true);
    try {
      const { key } = await randomizeKey(tune.id);
      onRandomized(key);
    } catch (e) {
      console.error(e);
    } finally {
      setBusyKey(false);
    }
  }

  async function onDeleteClick() {
    if (!window.confirm(`Remove “${tune.title}” from the deck for good?`)) return;
    setDeleting(true);
    try {
      await deleteTune(tune.id);
      onDelete(tune.id);
    } catch (e) {
      console.error(e);
      setDeleting(false);
    }
  }

  const irealUrl = irealUrlFor(tune);

  return (
    <section className="controls">
      <div className="action-row">
        <button className="btn btn-primary" onClick={onRandomize} disabled={busyKey}>
          🎲 Randomize Key
        </button>
        {irealUrl && (
          <a className="btn btn-ghost" href={irealUrl}>
            Open in iReal Pro
          </a>
        )}
      </div>

      {/* play tracking — one log per drawn tune (re-enabled when you draw again) */}
      <button
        className="btn btn-played"
        onClick={onPlayed}
        disabled={playedBusy || played}
      >
        {played ? "✓ Logged" : "✓ We played this"}
        {tune.times_played > 0 ? ` · ${tune.times_played}×` : ""}
      </button>

      {tune.charts.length > 0 && (
        <div className="charts">
          <span className="charts-label">Charts</span>
          <ul className="charts-list">
            {tune.charts.map((c, i) => (
              <li key={i} className="chart-ref">
                <img
                  className="chart-cover"
                  src={`/covers/${coverSlug(c.book)}.jpg`}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.visibility = "hidden";
                  }}
                />
                <span className="chart-book">{c.book}</span>
                <span className="chart-page">p.{c.page}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button className="btn-delete" onClick={onDeleteClick} disabled={deleting}>
        🗑 Remove this tune from the deck
      </button>
    </section>
  );
}
