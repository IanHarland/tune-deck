import { useEffect, useState } from "react";
import { deleteTune, markPlayed, randomizeKey, submitRating } from "../core/api";
import { irealUrlFor } from "../core/irealLink";
import type { Tune } from "../core/types";
import Slider from "./Slider";

interface Props {
  tune: Tune;
  anonId: string;
  onUpdate: (t: Tune) => void;
  onDelete: (id: string) => void;
  onRandomized: (key: string) => void;
}

// must match scripts/build_covers.py slug()
function coverSlug(book: string): string {
  return book
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function ResultControls({
  tune,
  anonId,
  onUpdate,
  onDelete,
  onRandomized,
}: Props) {
  const [obscurity, setObscurity] = useState(tune.obscurity_score);
  const [difficulty, setDifficulty] = useState(tune.difficulty_score);
  const [busyKey, setBusyKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [thanks, setThanks] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [playedBusy, setPlayedBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // reset the weigh-in sliders when a new tune is drawn
  useEffect(() => {
    setObscurity(tune.obscurity_score);
    setDifficulty(tune.difficulty_score);
    setThanks(false);
    setSubmitted(false);
  }, [tune.id]);

  async function onPlayed() {
    setPlayedBusy(true);
    try {
      onUpdate(await markPlayed(tune.id));
    } catch (e) {
      console.error(e);
    } finally {
      setPlayedBusy(false);
    }
  }

  async function onRandomize() {
    setBusyKey(true);
    try {
      const { last_played_key } = await randomizeKey(tune.id);
      onRandomized(last_played_key);
    } catch (e) {
      console.error(e);
    } finally {
      setBusyKey(false);
    }
  }

  async function onSubmit() {
    setSubmitting(true);
    try {
      const updated = await submitRating(
        tune.id,
        { obscurity, difficulty },
        anonId,
      );
      onUpdate(updated);
      setThanks(true);
      setSubmitted(true);
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
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

      {/* play tracking — UI is provisional; the data is what matters for now */}
      <button className="btn btn-played" onClick={onPlayed} disabled={playedBusy}>
        ✓ We played this
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

      <div className="rating-card">
        <h3 className="rating-title">Weigh in</h3>
        <Slider
          label="How obscure?"
          leftLabel="Common"
          rightLabel="Obscure"
          value={obscurity}
          onChange={setObscurity}
          accent="var(--teal)"
        />
        <Slider
          label="How hard?"
          leftLabel="Easy"
          rightLabel="Hard"
          value={difficulty}
          onChange={setDifficulty}
          accent="var(--gold)"
        />
        <button className={`btn btn-submit ${submitted ? "btn-submitted cursor-default" : ""}`} onClick={onSubmit} disabled={submitting || submitted}>
          {submitting ? "Saving…" : submitted ? "Rating submitted" : "Submit rating"}
        </button>
        <p className="vote-note">
          {thanks ? "Thanks — crowd scores updated. " : ""}
          obscurity {Math.round(tune.obscurity_score)} ({tune.obscurity_votes}{" "}
          {tune.obscurity_votes === 1 ? "vote" : "votes"}) · difficulty{" "}
          {Math.round(tune.difficulty_score)} ({tune.difficulty_votes}{" "}
          {tune.difficulty_votes === 1 ? "vote" : "votes"})
        </p>
      </div>

      <button className="btn-delete" onClick={onDeleteClick} disabled={deleting}>
        🗑 Remove this tune from the deck
      </button>
    </section>
  );
}
