# Kartomat

Kartomat is a spaced-repetition flashcard PWA. It's a single-page React
app — no backend — that stores decks, cards, and review progress locally
in the browser via IndexedDB (through Dexie), and schedules reviews using
the FSRS algorithm (`ts-fsrs`).

## Stack

- React 19 + TypeScript, built with Vite (`vite-plugin-pwa` for the
  installable/offline PWA shell).
- Dexie (IndexedDB) for local persistence — decks, cards, review progress,
  learning programmes. See [src/db.ts](src/db.ts) for the schema.
- `ts-fsrs` for spaced-repetition scheduling. See [src/fsrs.ts](src/fsrs.ts).
- Deployed to Cloudflare Pages (see `DEPLOYMENT.md` for the manual deploy
  flow: `npm run build` then `wrangler pages deploy dist`).

## Structure

- [src/App.tsx](src/App.tsx) — top-level shell: tab navigation (Learn /
  Decks), swipe-between-tabs gesture handling, and the study-session
  overlay lifecycle (`closed → entering → active → exiting`).
- [src/components/StudySession.tsx](src/components/StudySession.tsx) —
  the review flow itself: builds the due/new card queue, renders each
  card type, handles rating input, and commits reviews via
  `reviewCard()`/FSRS.
- [src/components/LearnHome.tsx](src/components/LearnHome.tsx) — deck
  overview, due/new counts, "Start Studying" entry point, learning
  programmes.
- [src/components/DeckList.tsx](src/components/DeckList.tsx) — deck
  management (import/export JSON decks).
- [src/types.ts](src/types.ts) — card types: `basic`, `cloze`,
  `truefalse`, `correction`, `cluster`. Each has different review UI.
- [src/fsrs.ts](src/fsrs.ts) — wraps `ts-fsrs`: `reviewCard`,
  `createNewProgress`, next-interval previews.

## Coding preferences

- **No automated end-to-end test suite.** There is no Playwright/Vitest/
  Jest harness in this repo (`package.json` has no test script or test
  dependency) — this is intentional, not an oversight. Verify UI changes
  by running `npm run dev` and manually exercising the flow in a browser;
  don't introduce a Playwright/automated-testing setup unless explicitly
  asked to. Do rely on `tsc -b` (via `npm run build`) and `npm run lint`
  (oxlint) to catch type/lint issues before handing off.
- Commits go straight to `main` — this is a single-developer project with
  no PR/review workflow. Direct commits and pushes to `main` are the norm.
