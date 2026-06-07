# Jazz Standard Picker — Project Handoff

## Project Summary

Build a simple app for jazz sessions that helps musicians pick a random jazz standard from a curated database.

The app should let users filter tunes by style/feel, obscurity, and difficulty. After a tune is selected, users can submit their opinion of how obscure and difficult the tune is, allowing the tune-ranking engine to improve over time.

There are two viable implementation paths:

1. **Mobile-first website**
2. **iOS / Android app**

The core product is the same in both paths.

---

## Core Concept

A user opens the app at a jazz session and chooses what kind of tune they want to play.

They can select one or more feel/style buttons:

- Ballad
- Medium swing
- Up
- Latin
- Waltz

They can also adjust two sliders:

- **Obscurometer**: common → obscure
- **Difficulty meter**: easy → hard

The app filters the tune database based on those choices and randomly selects a tune.

After the tune appears, users can:

- See the tune title
- See the original key
- Randomize a new key
- Submit their own rating of the tune’s obscurity
- Submit their own rating of the tune’s difficulty

User feedback should update the app’s understanding of each tune over time.

---

## Added Feature: Original Key + Randomized Key

Each tune in the database should include its original key.

When a tune is selected, the result screen should show:

- Tune title
- Original key
- Last played key, if one exists
- Button: **Randomize Key**

When the user taps **Randomize Key**, the app should:

1. Pick a random key from the 12 chromatic keys.
2. Save that randomized key to the database as `last_played_key`.
3. Display the randomized key immediately.

Example:

```txt
Tune: Autumn Leaves
Original Key: G minor / Bb major
Randomized Key: E minor
```

The randomized key does not replace the original key. It only updates the tune’s `last_played_key`.

---

## MVP Feature Set

### Required

- Tune database
- Feel/style filter buttons
- Obscurity slider
- Difficulty slider
- Random tune picker
- Result screen
- Original key display
- Randomize key button
- Save randomized key as `last_played_key`
- Post-selection feedback for obscurity and difficulty

### Nice-to-Have Later

- User accounts
- Personal tune history
- Session history
- “Do not repeat recently picked tunes”
- Weighted randomization
- Tune search
- Favorites
- Jam-session mode
- Leaderboard of most-picked tunes
- Per-user ratings vs global ratings
- Admin interface for adding/editing tunes
- Import tune list from CSV
- Different tune pools by scene, region, or book

---

## Data Model

### `tunes` Table

Stores the canonical tune data.

```sql
create table tunes (
  id uuid primary key default gen_random_uuid(),

  title text not null,
  alternate_titles text[],

  composer text,
  original_key text,
  last_played_key text,

  feel text not null,
  additional_feels text[],

  obscurity_score numeric not null default 50,
  difficulty_score numeric not null default 50,

  times_picked integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### Notes on Fields

#### `title`

Main tune title.

Example:

```txt
All The Things You Are
```

#### `alternate_titles`

Optional array for alternate names or spelling differences.

Example:

```txt
["All Things You Are"]
```

#### `composer`

Optional but useful.

Example:

```txt
Jerome Kern
```

#### `original_key`

The tune’s common/original key.

This can be a plain string because jazz standards sometimes have practical naming ambiguity.

Examples:

```txt
F minor
Bb major
G minor / Bb major
Eb
```

#### `last_played_key`

The most recent randomized key selected by the app.

This should be nullable.

Example:

```txt
Db major
```

#### `feel`

Primary feel/style category.

Allowed values for MVP:

```txt
ballad
medium_swing
up
latin
waltz
```

#### `additional_feels`

Optional array for tunes that fit multiple categories.

Example:

```txt
["ballad", "medium_swing"]
```

#### `obscurity_score`

Numerical score from 0–100.

Suggested interpretation:

```txt
0 = everyone knows it
50 = moderately known
100 = extremely obscure
```

#### `difficulty_score`

Numerical score from 0–100.

Suggested interpretation:

```txt
0 = very easy
50 = moderate
100 = very hard
```

#### `times_picked`

Increment each time a tune is selected.

This can later help prevent over-repetition or support analytics.

---

## Feedback Data Model

### `tune_ratings` Table

Stores user-submitted feedback after a tune is selected.

```sql
create table tune_ratings (
  id uuid primary key default gen_random_uuid(),

  tune_id uuid not null references tunes(id) on delete cascade,

  user_id uuid,
  anonymous_user_id text,

  obscurity_rating numeric,
  difficulty_rating numeric,

  created_at timestamptz not null default now()
);
```

### Rating Behavior

After a tune is shown, the user can adjust sliders for:

- “How obscure is this tune?”
- “How difficult is this tune?”

When submitted, save a row in `tune_ratings`.

Then update the tune’s aggregate scores.

Simple MVP update strategy:

```txt
new_score = average of all ratings for that tune
```

Better later strategy:

```txt
new_score = weighted average of:
- existing curated score
- user ratings
- recency-weighted ratings
- trusted-user ratings
```

For MVP, simple averages are fine.

---

## Key Randomization Logic

### Valid Keys

Use 12 chromatic roots.

Simple version:

```ts
const KEYS = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B"
];
```

Optional later version could include major/minor quality, but MVP can just randomize the root.

### Randomize Key Function

```ts
function randomKey(): string {
  const keys = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  return keys[Math.floor(Math.random() * keys.length)];
}
```

### Save Behavior

When user clicks **Randomize Key**:

```ts
const newKey = randomKey();

await updateTune(tune.id, {
  last_played_key: newKey
});
```

Then update the UI immediately:

```ts
setDisplayedKey(newKey);
```

---

## Tune Selection Logic

### Basic Algorithm

1. User selects feel/style.
2. User sets obscurity target/range.
3. User sets difficulty target/range.
4. Query tunes matching the selected criteria.
5. Randomly select one tune from the result set.
6. Increment `times_picked`.
7. Show the tune.

### Basic Pseudocode

```ts
type PickTuneFilters = {
  feels: string[];
  obscurityMin: number;
  obscurityMax: number;
  difficultyMin: number;
  difficultyMax: number;
};

function pickRandomTune(tunes: Tune[], filters: PickTuneFilters): Tune | null {
  const matchingTunes = tunes.filter((tune) => {
    const matchesFeel =
      filters.feels.length === 0 ||
      filters.feels.includes(tune.feel) ||
      tune.additional_feels?.some((feel) => filters.feels.includes(feel));

    const matchesObscurity =
      tune.obscurity_score >= filters.obscurityMin &&
      tune.obscurity_score <= filters.obscurityMax;

    const matchesDifficulty =
      tune.difficulty_score >= filters.difficultyMin &&
      tune.difficulty_score <= filters.difficultyMax;

    return matchesFeel && matchesObscurity && matchesDifficulty;
  });

  if (matchingTunes.length === 0) {
    return null;
  }

  return matchingTunes[Math.floor(Math.random() * matchingTunes.length)];
}
```

---

## UX Flow

### Home / Picker Screen

User sees:

- App title
- Feel/style buttons
- Obscurity slider
- Difficulty slider
- Button: **Pick a Tune**

Example layout:

```txt
Jazz Standard Picker

[Ballad] [Medium Swing] [Up] [Latin] [Waltz]

Obscurometer
Common -------------------- Obscure

Difficulty
Easy ---------------------- Hard

[Pick a Tune]
```

### Tune Result Screen

After selecting a tune:

```txt
Tune picked:

All The Things You Are

Original Key: Ab
Last Played Key: Db

[Randomize Key]

How obscure is this tune?
Common -------------------- Obscure

How difficult is this tune?
Easy ---------------------- Hard

[Submit Rating]

[Pick Another Tune]
```

If there is no `last_played_key` yet:

```txt
Last Played Key: Not randomized yet
```

---

## Path 1: Mobile-First Website

### Summary

Build a responsive web app first. This is the fastest and simplest path.

Recommended stack:

- Next.js
- TypeScript
- Tailwind CSS
- Supabase Postgres
- Supabase Auth later if needed
- Vercel deployment

### Why This Path

Pros:

- Fastest to build
- Easiest to deploy
- Easy to share with musicians via URL
- No App Store review
- Can work well on iPhone if designed mobile-first
- Easier database iteration
- Can later become a PWA
- Can later be ported to native app

Cons:

- Not a true App Store app
- Less native feel
- Offline support takes extra work
- Push notifications are more limited
- Users may not treat it as “installed software”

### Suggested Folder Structure

```txt
app/
  page.tsx
  tunes/
    [id]/
      page.tsx
components/
  FeelButton.tsx
  SliderControl.tsx
  TuneResult.tsx
  RatingForm.tsx
  RandomizeKeyButton.tsx
lib/
  supabase.ts
  tunePicker.ts
  keys.ts
types/
  tune.ts
```

### Core Pages

#### `/`

Main picker page.

Responsibilities:

- Load tune list or query filtered tunes
- Display filters
- Pick random tune
- Navigate/show result

#### Optional `/tunes/[id]`

Tune detail page.

Responsibilities:

- Show tune details
- Show original key
- Show last played key
- Allow key randomization
- Allow feedback submission

For MVP, a separate tune page is optional. The whole app can be a single page.

### API / Database Actions

Needed actions:

```txt
getTunes(filters)
pickTune(filters)
incrementTimesPicked(tuneId)
updateLastPlayedKey(tuneId, key)
submitTuneRating(tuneId, obscurityRating, difficultyRating)
recalculateTuneScores(tuneId)
```

### Recommended MVP Order

1. Create Supabase project.
2. Create `tunes` table.
3. Seed 30–100 jazz standards manually.
4. Build static picker UI.
5. Add filter state.
6. Add random picker logic.
7. Add result display.
8. Add original key display.
9. Add randomize key button.
10. Save `last_played_key`.
11. Add rating sliders.
12. Save ratings.
13. Recalculate aggregate obscurity/difficulty.
14. Deploy to Vercel.

### Mobile-First Design Notes

Design for one-handed phone use.

Prioritize:

- Big buttons
- Clear tune title
- Minimal typing
- Large sliders
- High contrast
- Fast interactions
- No login for MVP

This is probably the best first version.

---

## Path 2: iOS / Android App

### Summary

Build a real mobile app for iOS and Android.

Recommended stack:

- Expo
- React Native
- TypeScript
- Supabase
- EAS Build
- App Store Connect
- Google Play Console

### Why This Path

Pros:

- Real app-store presence
- Native app feel
- Better offline support potential
- Better long-term mobile UX
- Easier to add native features later

Cons:

- More setup
- App Store / Play Store overhead
- Certificates and builds
- More device testing
- Slower release cycle
- Slightly more friction for early iteration

### Suggested Folder Structure

```txt
app/
  index.tsx
  tune-result.tsx
components/
  FeelButton.tsx
  SliderControl.tsx
  TuneCard.tsx
  RatingForm.tsx
  RandomizeKeyButton.tsx
lib/
  supabase.ts
  tunePicker.ts
  keys.ts
types/
  tune.ts
```

### Core Screens

#### Picker Screen

- Feel buttons
- Obscurity slider
- Difficulty slider
- Pick Tune button

#### Result Screen

- Tune title
- Original key
- Last played key
- Randomize Key button
- Rating controls
- Pick Another Tune button

### Recommended Expo Libraries

Likely useful:

```txt
expo
expo-router
@supabase/supabase-js
react-native
react-native-url-polyfill
@react-native-community/slider
```

Optional later:

```txt
expo-secure-store
expo-sqlite
react-native-gesture-handler
react-native-reanimated
```

### Mobile App MVP Order

1. Create Expo app.
2. Set up Supabase client.
3. Create tune schema in Supabase.
4. Seed tune database.
5. Build picker screen.
6. Build tune picker function.
7. Build result screen.
8. Add original key display.
9. Add random key button.
10. Persist `last_played_key`.
11. Add rating sliders.
12. Persist user ratings.
13. Recalculate tune aggregate scores.
14. Test on real iPhone with Expo Go.
15. Build with EAS.
16. Use TestFlight for iOS testing.
17. Add Android build later if desired.

### App Store Notes

For MVP, avoid anything that complicates review:

- No payments
- No copyrighted lead sheets
- No Real Book charts
- No audio recordings unless owned/licensed
- No user-generated public text fields unless moderation is considered

Tune metadata is fine:

- Title
- Composer
- Feel
- Original key
- Difficulty
- Obscurity

Do not include copyrighted sheet music, melodies, or lyrics.

---

## Recommendation

Start with **Path 1: Mobile-first website**.

Reason:

The core app does not require native device features. A mobile-first web app will let you test the actual product idea quickly with real musicians. Once the flow feels good, porting to Expo/React Native will be straightforward because the core logic, database, and TypeScript types can mostly carry over.

Best development sequence:

```txt
Mobile-first website → PWA → Expo native app if people actually use it
```

---

## Suggested Supabase Seed Data Shape

Example seed row:

```json
{
  "title": "All The Things You Are",
  "alternate_titles": [],
  "composer": "Jerome Kern",
  "original_key": "Ab",
  "last_played_key": null,
  "feel": "medium_swing",
  "additional_feels": ["ballad"],
  "obscurity_score": 15,
  "difficulty_score": 70,
  "times_picked": 0
}
```

Another example:

```json
{
  "title": "Stablemates",
  "alternate_titles": [],
  "composer": "Benny Golson",
  "original_key": "Db",
  "last_played_key": null,
  "feel": "medium_swing",
  "additional_feels": [],
  "obscurity_score": 65,
  "difficulty_score": 75,
  "times_picked": 0
}
```

---

## Open Product Questions

Claude should help resolve these during implementation:

1. Should users select one feel or multiple feels?
2. Should the sliders represent exact target values or acceptable ranges?
3. Should there be a “surprise me” mode that ignores filters?
4. Should key randomization include major/minor qualities or only root notes?
5. Should `last_played_key` be global or per user/session?
6. Should user ratings immediately affect public scores?
7. Should there be anonymous users from the start?
8. Should repeated tune picks be avoided within a session?
9. Should the app have an admin-only tune editor?
10. Should tune data be seeded from a CSV?

Suggested MVP answers:

1. Allow multiple feels.
2. Use ranges.
3. Add later.
4. Root notes only for MVP.
5. Global for MVP.
6. Yes, using a simple average.
7. Use anonymous IDs if easy; otherwise skip.
8. Add later.
9. Add later.
10. Yes, CSV seed would be useful.

---

## Claude Implementation Prompt

Use this as the starting prompt for Claude:

```txt
We are building a Jazz Standard Picker app.

The app picks a random jazz standard from a database of tunes. Tunes have title, composer, original_key, last_played_key, feel, additional_feels, obscurity_score, difficulty_score, and times_picked.

The user can filter by feel/style using buttons: ballad, medium swing, up, latin, and waltz. The user can also adjust obscurity and difficulty sliders. The app filters matching tunes and randomly selects one.

After a tune is picked, show the title, original key, and last played key. Add a Randomize Key button that picks one of the 12 chromatic keys and saves it to the tune as last_played_key.

After a tune is picked, the user can rate its obscurity and difficulty. Save those ratings to a tune_ratings table and update the tune's aggregate obscurity_score and difficulty_score.

Build either:
1. A mobile-first Next.js + TypeScript + Tailwind + Supabase website, or
2. An Expo React Native + TypeScript + Supabase iOS/Android app.

Start with the simplest MVP. Avoid authentication unless needed. Do not include copyrighted charts, lead sheets, melodies, or lyrics.
```

---

## Definition of Done for MVP

The MVP is complete when:

- A user can open the app on a phone.
- A user can choose at least one feel/style.
- A user can set obscurity and difficulty filters.
- A user can tap **Pick a Tune**.
- The app displays a random matching tune.
- The app displays the tune’s original key.
- The user can tap **Randomize Key**.
- The randomized key is saved as `last_played_key`.
- The user can rate obscurity and difficulty.
- The ratings are saved.
- The tune’s aggregate scores update.
- The app is deployed or runnable on a real phone.

---

## Non-Goals for MVP

Do not build these yet:

- Lead sheets
- Real Book chart display
- Audio playback
- Payments
- Social features
- Complex accounts
- Push notifications
- Region-specific tune pools
- Machine learning recommendation engine
- Native-only features
- Full admin dashboard

Keep the first version simple and usable at an actual jazz session.
