# Kartomat deck authoring guide (for LLMs)

You are reading this because a user wants you to create a **flashcard deck for Kartomat**, a spaced-repetition app. Decks are imported as a single `.json` file. This guide tells you the exact file format, what every card type does, and how to check your file by running a validator before you hand it over.

Follow it literally. The app does very little forgiving: a wrong type, a duplicate id or a misplaced field can silently drop cards or make them behave wrongly.

## 1. Workflow

1. **Clarify** (ask only what you can't infer): the source material, the language of the cards, roughly how many cards, and any preferred mix of card types. Default to the language of the source material.
2. **Plan** the deck: split the material into topics, then decide which facts suit which card type (section 4).
3. **Write** the JSON file (sections 2-5). Save it to a file named `<deck-id>.json`. If you cannot create files, output *only* one JSON code block so the user can save it.
4. **Validate** (section 7): save the validator script, run it on your file, and fix every error. Repeat until it exits with code 0. Then read the warnings and fix those that apply.
5. **Deliver** the file with a short summary: number of cards per type, and any warnings you deliberately kept.

If you cannot execute code, say so plainly: tell the user the file has **not** been machine-checked, and go through the checklist in section 8 by hand. The app itself also validates on import and will show the first problems it finds.

## 2. File structure

The file is one JSON object. UTF-8, no comments, no trailing commas, no text before or after it, and no Markdown code fences inside the file.

```json
{
  "meta": {
    "titel": "Vorlesung 01: Aristoteles",
    "kurs": "Einführung in die Philosophie",
    "quelle": "Vorlesungsskript WS 2025/26, Folien 1-40"
  },
  "decks": [
    {
      "id": "vl01_aristoteles",
      "titel": "VL 01 – Aristoteles",
      "cards": [ ]
    }
  ]
}
```

Rules:

- The top level has `meta` (optional) and `decks` (required, non-empty array). **Cards live inside a deck's `cards` array**, never at the top level.
- Usually one deck per file. Several decks per file are allowed.
- Field names are German (`titel`, `kurs`, `quelle`) and must be spelled exactly. The card *content* can be in any language.

### Deck fields

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Lowercase letters, digits, `_` and `-` only, e.g. `vl01_aristoteles`. Stable identifier; also used in the export file name. |
| `titel` | yes | Display name of the deck, plain text. |
| `cards` | yes | Array of cards. |
| `meta` | no | Same shape as the top-level `meta`. |

### `meta` fields (all optional, all strings)

| Field | Shown in app | Meaning |
|---|---|---|
| `titel` | no | Title of the material. |
| `kurs` | **yes**, on the deck card | Course or subject name. Recommended. |
| `quelle` | no | Where the content comes from. Recommended. |
| `klausurformat` | no | Description of the exam format the deck prepares for. |
| `hinweis_falschaussagen` | no | Note about false statements in the deck (e.g. that `correction` cards contain deliberately wrong text). |
| `kartentypen` | no | Object mapping a card type name to a one-line description of how this deck uses it, e.g. `{ "cluster": "Aussagen a-d, jeweils richtig/falsch" }`. |

`meta` placed at the **top level applies to every deck in the file** and takes precedence over a deck's own `meta`.

## 3. Common card fields

Every card is an object with these fields:

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique, **stable** and prefixed with the deck id plus `_`, e.g. `vl01_aristoteles_017`. Lowercase letters, digits, `_`, `-` only. See section 6. |
| `type` | yes | Exactly one of: `basic`, `cloze`, `truefalse`, `correction`, `cluster`. |
| `tags` | no | Array of short strings shown as chips on the card, e.g. `["Ethik", "Tugend"]`. Use 1-3 consistent tags per card (topic, lecture). |
| *type-specific fields* | yes | See section 4. |

**Do not add any other field.** Unknown fields are never displayed, and a few (`deckId`, `createdAt`, `progress`) would corrupt the deck. In particular never include study `progress`: new decks must start unlearned.

## 4. Card types

All card text is rendered as **plain text**. There is no Markdown, HTML or LaTeX, and a line break (`\n`) is shown as a single space. Write formulas and symbols as plain Unicode (`x²`, `≤`, `→`). Escape any `"` inside a string as `\"`.

### 4.1 `basic` – question and answer

Use for definitions, terms, who/what/why questions. The user sees `front`, taps "Show Answer", sees `back`, then rates how well they knew it.

| Field | Required | Notes |
|---|---|---|
| `front` | yes | The question or prompt. |
| `back` | yes | The answer. Keep it short enough to recall in one go. |

```json
{
  "id": "vl01_aristoteles_001",
  "type": "basic",
  "tags": ["Ethik"],
  "front": "Was versteht Aristoteles unter eudaimonia?",
  "back": "Ein gelungenes, tugendhaftes Leben als höchstes Ziel menschlichen Handelns (oft mit „Glückseligkeit“ übersetzt)."
}
```

### 4.2 `cloze` – fill in the blank

Use for key terms inside a sentence. Mark each blank as `{{c1::answer}}` in `text`. While the question is shown, blanks are displayed as `[...]`; after reveal they show the answers.

| Field | Required | Notes |
|---|---|---|
| `text` | yes | A full sentence with at least one `{{c1::answer}}`. |
| `extra` | no | Plain-text explanation shown after reveal. |

```json
{
  "id": "vl01_aristoteles_002",
  "type": "cloze",
  "tags": ["Ethik"],
  "text": "Nach Aristoteles liegt die Tugend als {{c1::Mitte}} zwischen den Extremen des {{c1::Übermaßes}} und des Mangels.",
  "extra": "Bekannt als Mesotes-Lehre (Nikomachische Ethik, Buch II)."
}
```

Cloze rules:

- The number after `c` is required (`c1`, `c2`, …) but **has no effect**: all blanks of a card are hidden and revealed together, so a card is one question. Use `c1` everywhere.
- Each blank must be on one line, written exactly `{{c1::answer}}`. **No hint syntax** (`{{c1::answer::hint}}` would show `answer::hint`).
- Keep blanks short (a term or a few words), and use at most 2-3 per card; the remaining sentence must still make the answer unique.

### 4.3 `truefalse` – single statement

Use for claims the learner must judge. The user taps True or False, then reveals and rates. **If the user answers wrongly, the rating is automatically forced to "Again".** If they don't answer, they grade themselves. So the statement must be *unambiguously* true or false.

| Field | Required | Notes |
|---|---|---|
| `statement` | yes | One claim. |
| `answer` | yes | The JSON boolean `true` or `false`. **Not** the string `"true"`. |
| `explanation` | recommended | Why it is true/false; shown after reveal. For a false statement, state the correct fact. |

```json
{
  "id": "vl01_aristoteles_003",
  "type": "truefalse",
  "tags": ["Logik"],
  "statement": "Aristoteles hielt die Ideenlehre Platons für überzeugend und übernahm sie unverändert.",
  "answer": false,
  "explanation": "Aristoteles kritisierte die Ideenlehre und verlegte die Formen (eide) in die Einzeldinge."
}
```

Make false statements *plausible* (a typical misconception or a swapped detail), not absurd, and balance true and false answers across the deck.

### 4.4 `correction` – find and fix the error

Use to train precise knowledge. The user sees a statement that **is wrong**, tries to state the right version, then reveals the correction. It is self-graded.

| Field | Required | Notes |
|---|---|---|
| `false_statement` | yes | A plausible but incorrect statement. |
| `correction` | yes | The correct statement or fact, ideally as a full sentence. |

```json
{
  "id": "vl01_aristoteles_004",
  "type": "correction",
  "tags": ["Metaphysik"],
  "false_statement": "Aristoteles unterscheidet vier Prinzipien der Politik: Materie, Form, Bewegung und Zweck.",
  "correction": "Die vier Ursachen (Materie, Form, Wirkursache, Zweckursache) gehören zur Naturphilosophie und Metaphysik, nicht zur Politik."
}
```

### 4.5 `cluster` – exam-style statement group

Use for multiple-statement exam questions: a stem and several statements (labelled a, b, c, …), each judged true or false. As with `truefalse`, **if every statement was answered and any is wrong, the rating is forced to "Again"**.

| Field | Required | Notes |
|---|---|---|
| `stem` | yes | The shared question or topic sentence. |
| `items` | yes | Array of 3-5 items (at least 1). |

Each item:

| Field | Required | Notes |
|---|---|---|
| `label` | yes | Short label, usually `"a"`, `"b"`, `"c"`, … unique within the card. |
| `statement` | yes | The claim. |
| `answer` | yes | The JSON boolean `true` or `false`. |
| `explanation` | recommended | Shown after reveal. |

```json
{
  "id": "vl01_aristoteles_005",
  "type": "cluster",
  "tags": ["Ethik", "Klausur"],
  "stem": "Welche Aussagen zur Nikomachischen Ethik treffen zu?",
  "items": [
    { "label": "a", "statement": "Glück wird als Tätigkeit der Seele gemäß der Tugend bestimmt.", "answer": true, "explanation": "Zentrale Definition in Buch I." },
    { "label": "b", "statement": "Ethische Tugenden sind angeboren und müssen nicht eingeübt werden.", "answer": false, "explanation": "Sie entstehen durch Gewöhnung und Übung." },
    { "label": "c", "statement": "Die Klugheit (phronesis) ist eine Verstandestugend.", "answer": true, "explanation": "Sie steuert die Wahl der rechten Mitte." }
  ]
}
```

### Choosing types and writing good cards

- **One fact per card.** If an answer has several independent parts, split it into several cards.
- **Self-contained.** Cards are shuffled and shown in isolation. Never write "see above", "the previous card" or depend on order.
- **Test understanding, not just wording**: prefer "why/how/what follows" over copying slide titles. Don't invent facts that aren't in the source material.
- **Mix types** unless the user asks otherwise: `basic` and `cloze` for knowledge, `truefalse`/`correction`/`cluster` for typical misconceptions and exam practice.
- Keep each field short (a sentence or two). The validator warns above 600 characters.
- Write all content in the same language, matching the source material.

## 5. Complete minimal example

This file passes the validator.

```json
{
  "meta": {
    "titel": "Vorlesung 01: Aristoteles",
    "kurs": "Einführung in die Philosophie",
    "quelle": "Vorlesungsskript WS 2025/26"
  },
  "decks": [
    {
      "id": "vl01_aristoteles",
      "titel": "VL 01 – Aristoteles",
      "cards": [
        {
          "id": "vl01_aristoteles_001",
          "type": "basic",
          "tags": ["Ethik"],
          "front": "Was versteht Aristoteles unter eudaimonia?",
          "back": "Ein gelungenes, tugendhaftes Leben als höchstes Ziel menschlichen Handelns."
        },
        {
          "id": "vl01_aristoteles_002",
          "type": "cloze",
          "tags": ["Ethik"],
          "text": "Nach Aristoteles liegt die Tugend als {{c1::Mitte}} zwischen Übermaß und Mangel.",
          "extra": "Mesotes-Lehre."
        },
        {
          "id": "vl01_aristoteles_003",
          "type": "truefalse",
          "tags": ["Logik"],
          "statement": "Aristoteles übernahm Platons Ideenlehre unverändert.",
          "answer": false,
          "explanation": "Er kritisierte sie und verlegte die Formen in die Einzeldinge."
        },
        {
          "id": "vl01_aristoteles_004",
          "type": "correction",
          "tags": ["Metaphysik"],
          "false_statement": "Die vier Ursachen sind Materie, Form, Bewegung und Zweck.",
          "correction": "Die vier Ursachen sind Materie, Form, Wirkursache und Zweckursache."
        },
        {
          "id": "vl01_aristoteles_005",
          "type": "cluster",
          "tags": ["Ethik"],
          "stem": "Welche Aussagen zur Tugend treffen zu?",
          "items": [
            { "label": "a", "statement": "Ethische Tugenden entstehen durch Übung.", "answer": true, "explanation": "Gewöhnung ist der Weg." },
            { "label": "b", "statement": "Ethische Tugenden sind angeboren.", "answer": false, "explanation": "Sie müssen eingeübt werden." },
            { "label": "c", "statement": "Die Klugheit ist eine Verstandestugend.", "answer": true, "explanation": "Sie wählt die rechte Mitte." }
          ]
        }
      ]
    }
  ]
}
```

## 6. Ids and re-importing

- A card's `id` is its identity in the user's database, **across all decks**. Prefix every card id with its deck id (`<deck-id>_001`, `<deck-id>_002`, …) so ids never collide with another deck. The validator enforces this.
- Importing a deck whose ids already exist **updates** those cards' content and **keeps the user's learning progress**. So when you revise or extend an existing deck, keep the ids of unchanged cards and give new cards new, unused numbers.
- **Never reuse an id for a different card**: the old card's progress would attach to unrelated content.
- Removing a card from the file does *not* remove it from the app.
- Changing a deck `id` creates a new, separate deck.

## 7. Validating your file

The validator below is the same code the app's importer uses. It needs only **Node.js 18+** (no packages).

1. Save the whole code block as `validate-deck.mjs` (exactly as written, including the last lines).
2. Run `node validate-deck.mjs <deck-file>.json`.
3. Exit code **0** means the file will import. Any `ERROR` line must be fixed, then run again. `WARNING` lines are not fatal but usually point to a real problem; fix them unless you have a reason not to.

If Node.js is unavailable, translate the script to another language you can run (the rules are the ones described in this guide), or fall back to the checklist in section 8.

```js
{{VALIDATOR_SOURCE}}

// ---- command line entry point -------------------------------------------------------------
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node validate-deck.mjs <deck-file>.json');
  process.exit(2);
}

let data;
try {
  data = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
} catch (e) {
  console.error(`ERROR: not valid JSON (${e.message})`);
  console.error('Common causes: Markdown code fences or prose around the JSON, trailing commas, unescaped " inside a string, comments.');
  process.exit(1);
}

const result = validateDeckFile(data, { authoring: true });
for (const e of result.errors) console.error(`ERROR   ${e}`);
for (const w of result.warnings) console.error(`WARNING ${w}`);
const types = Object.entries(result.stats.byType).map(([t, n]) => `${n} ${t}`).join(', ');
console.log(`${result.stats.decks} deck(s), ${result.stats.cards} card(s)${types ? ` (${types})` : ''}`);
console.log(result.ok ? `OK: no errors, ${result.warnings.length} warning(s).` : `FAILED: ${result.errors.length} error(s), ${result.warnings.length} warning(s).`);
process.exit(result.ok ? 0 : 1);
```

The validator checks structure and types, id format and uniqueness, required fields per card type, boolean answers, cloze syntax, and plain-text rules. It cannot check that the content is **correct** or faithful to the source material. That is your job: re-read your cards against the source before delivering.

## 8. Manual checklist (if you cannot run code)

- [ ] The file is a single JSON object with `decks` (array); every deck has `id`, `titel`, `cards`.
- [ ] No text outside the JSON, no code fences, no comments, no trailing commas.
- [ ] Every card has a unique `id` starting with `<deck-id>_`, and a `type` that is one of the five.
- [ ] Every card has exactly the fields of its type and no other fields; no `progress`.
- [ ] `truefalse.answer` and `cluster.items[].answer` are `true`/`false`, not strings.
- [ ] Every `cloze.text` contains `{{c1::...}}` blanks on one line, with no `::hint`.
- [ ] Card text contains no Markdown, HTML or LaTeX, and no line breaks.
- [ ] Tell the user the file was not machine-validated.
