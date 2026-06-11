// Portable types — shared by web now and a future Expo app. No DOM/React.

export type Feel = "ballad" | "medium_swing" | "up" | "latin" | "waltz";

export const FEELS: Feel[] = ["ballad", "medium_swing", "up", "latin", "waltz"];

export const FEEL_LABELS: Record<Feel, string> = {
  ballad: "Ballad",
  medium_swing: "Medium Swing",
  up: "Up",
  latin: "Latin",
  waltz: "Waltz",
};

export interface ChartRef {
  book: string;
  page: string;
}

export interface Tune {
  id: string;
  title: string;
  alternate_titles: string[];
  composer: string | null;
  original_key: string | null;
  last_played_key: string | null;
  feel: Feel;
  additional_feels: Feel[];
  ireal_style: string | null;
  ireal_url: string | null;
  charts: ChartRef[];
  time_signature: string | null;
  tags: string[];
  obscurity_score: number;
  difficulty_score: number;
  obscurity_votes: number;
  difficulty_votes: number;
  rating_score: number | null; // crowd like-rate 0–100 (% liked); a neutral 50
  // placeholder until the first swipe (gate display/real-opinion on rating_votes)
  rating_votes: number; // total swipes (likes + dislikes); 0 = unvoted placeholder
  times_picked: number;
  times_played: number;
  last_picked_at: string | null;
  last_played_at: string | null;
}

// Feel is a hard filter. The slider values are SOFT targets (bullseyes): tunes
// whose score is near the value are most likely; distance in either direction
// lowers likelihood but never excludes a tune. The `*On` flags toggle a slider's
// bias on/off WITHOUT losing its position (off = the bullseye logic is ignored).
export interface Filters {
  feels: Feel[];
  obscurity: number; // 0..100 slider position
  difficulty: number; // 0..100 slider position
  hipness: number; // 0..100 slider position (biases by the 5★ crowd rating)
  obscurityOn: boolean; // does obscurity bias the draw?
  difficultyOn: boolean; // does difficulty bias the draw?
  hipnessOn: boolean; // does hipness bias the draw?
  excludeHenny: boolean; // hard-exclude all Joe Henderson ("Henny") tunes
}

// Picking modes. "normal" honors the filters; the rest are novelty/utility modes.
export type Mode =
  | "normal"
  | "beginner"
  | "hard"
  | "spain"
  | "lame"
  | "smalls";

export const MODE_LABELS: Record<Mode, string> = {
  normal: "Normal",
  beginner: "Beginner",
  hard: "Hard",
  spain: "Spain",
  lame: "Lame",
  smalls: "Smalls",
};
