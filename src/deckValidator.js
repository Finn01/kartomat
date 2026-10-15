// Kartomat deck-file validator.
//
// Dependency-free ES module. It runs unchanged in two places:
//   - in the app, where the importer uses it to reject broken files with readable errors, and
//   - in the downloadable LLM guide, which embeds this exact source so a model can validate the
//     deck file it just wrote (`authoring: true`) before handing it over.
//
// Errors mean "the app would crash, silently drop data, or show the card wrongly".
// Warnings mean "works, but is probably not what you want".

export const CARD_TYPES = ['basic', 'cloze', 'truefalse', 'correction', 'cluster'];

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const META_TEXT_KEYS = ['titel', 'kurs', 'quelle', 'klausurformat', 'hinweis_falschaussagen'];
const MAX_FIELD_LENGTH = 600;

// Text fields of each card type (all rendered as plain text), plus its other allowed keys.
const CARD_SPEC = {
  basic: { required: ['front', 'back'], optional: [] },
  cloze: { required: ['text'], optional: ['extra'] },
  truefalse: { required: ['statement'], optional: ['explanation'] },
  correction: { required: ['false_statement', 'correction'], optional: [] },
  cluster: { required: ['stem'], optional: [] },
};
const ITEM_KEYS = ['label', 'statement', 'answer', 'explanation'];
const PROGRESS_NUMBERS = ['stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'reps', 'lapses', 'state'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const label = (v) => JSON.stringify(v);

/**
 * @param {unknown} data parsed JSON
 * @param {{ authoring?: boolean }} [options]
 *   authoring: true  → strict rules for newly written files (id format, no extra fields, no
 *                      study progress). The app's importer uses false so it still accepts its
 *                      own exports, which carry `deckId`, `createdAt` and `progress`.
 */
export function validateDeckFile(data, options = {}) {
  const authoring = options.authoring === true;
  const errors = [];
  const warnings = [];
  const stats = { decks: 0, cards: 0, byType: {} };

  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const warn = (where, msg) => warnings.push(`${where}: ${msg}`);
  const authorErr = (where, msg) => { if (authoring) err(where, msg); };
  const finish = () => ({ ok: errors.length === 0, errors, warnings, stats });

  function checkMeta(meta, where) {
    if (meta === undefined) return;
    if (!isObject(meta)) return err(where, 'must be an object');
    for (const key of META_TEXT_KEYS) {
      if (meta[key] !== undefined && typeof meta[key] !== 'string') err(`${where}.${key}`, 'must be a string');
    }
    if (meta.kartentypen !== undefined) {
      if (!isObject(meta.kartentypen)) err(`${where}.kartentypen`, 'must be an object of string values');
      else for (const [k, v] of Object.entries(meta.kartentypen)) {
        if (typeof v !== 'string') err(`${where}.kartentypen.${k}`, 'must be a string');
      }
    }
    for (const key of Object.keys(meta)) {
      if (![...META_TEXT_KEYS, 'kartentypen'].includes(key)) warn(`${where}.${key}`, 'unknown meta key (ignored by the app)');
    }
  }

  // Card text is rendered as plain text: no markdown, HTML, LaTeX, and line breaks collapse.
  function checkPlainText(where, value) {
    if (value.length > MAX_FIELD_LENGTH) warn(where, `${value.length} characters is long for a flashcard field (aim for under ${MAX_FIELD_LENGTH})`);
    if (/[\r\n]/.test(value)) warn(where, 'contains a line break; the app shows it as a single space');
    if (/\*\*[^*]+\*\*|`|<\/?[a-z][^>]*>|\\\(|\\\[|\$\$/i.test(value)) {
      warn(where, 'looks like markdown/HTML/LaTeX; the app shows card text as plain text, so the markup would appear literally');
    }
  }

  function checkText(where, value, required) {
    if (value === undefined || value === null) {
      if (required) err(where, 'is required');
      return;
    }
    if (typeof value !== 'string') return err(where, `must be a string, got ${label(value)}`);
    if (value.trim() === '') return required ? err(where, 'must not be empty') : undefined;
    checkPlainText(where, value);
  }

  function checkCloze(where, text) {
    const opens = (text.match(/\{\{/g) || []).length;
    const blanks = [...text.matchAll(/\{\{c\d+::(.*?)\}\}/g)];
    if (blanks.length === 0) return err(where, 'needs at least one blank written as {{c1::answer}}');
    if (opens !== blanks.length) err(where, 'has a malformed blank; every "{{" must be a complete {{c1::answer}} on one line');
    for (const [, answer] of blanks) {
      if (answer.trim() === '') err(where, 'has an empty blank {{c1::}}');
      else if (answer.includes('::')) {
        authorErr(where, `blank "${answer}" uses "::" (hint syntax); hints are not supported and would show up as part of the answer`);
      }
    }
  }

  function checkProgress(where, progress) {
    if (authoring) return err(where, 'do not include study progress in a newly written deck');
    if (!isObject(progress)) return err(where, 'must be an object');
    if (typeof progress.due !== 'string' || Number.isNaN(Date.parse(progress.due))) err(`${where}.due`, 'must be an ISO date string');
    for (const key of PROGRESS_NUMBERS) {
      if (typeof progress[key] !== 'number') err(`${where}.${key}`, 'must be a number');
    }
  }

  function checkCluster(where, card) {
    if (!Array.isArray(card.items) || card.items.length === 0) return err(`${where}.items`, 'must be a non-empty array');
    if (card.items.length === 1) warn(`${where}.items`, 'a cluster usually has 3-5 statements; use a truefalse card for a single one');
    const labels = new Set();
    const noExplanation = [];
    card.items.forEach((item, i) => {
      const at = `${where}.items[${i}]`;
      if (!isObject(item)) return err(at, 'must be an object');
      checkText(`${at}.label`, item.label, true);
      checkText(`${at}.statement`, item.statement, true);
      if (typeof item.answer !== 'boolean') err(`${at}.answer`, `must be the boolean true or false (not a string), got ${label(item.answer)}`);
      checkText(`${at}.explanation`, item.explanation, false);
      if (!isText(item.explanation)) noExplanation.push(item.label ?? i);
      if (typeof item.label === 'string') {
        if (labels.has(item.label)) warn(`${at}.label`, `label ${label(item.label)} is used twice`);
        labels.add(item.label);
      }
      if (authoring) for (const key of Object.keys(item)) if (!ITEM_KEYS.includes(key)) err(`${at}.${key}`, 'unknown field');
    });
    if (noExplanation.length) warn(`${where}.items`, `no explanation for item(s) ${noExplanation.join(', ')}; explanations are shown after answering`);
  }

  if (!isObject(data)) {
    err('file', 'the top level must be a JSON object: { "decks": [ ... ] }');
    return finish();
  }

  checkMeta(data.meta, 'meta');

  if (!Array.isArray(data.decks)) {
    err('decks', Array.isArray(data.cards)
      ? 'missing. Cards must be nested inside a deck: { "decks": [ { "id": ..., "titel": ..., "cards": [ ... ] } ] }'
      : 'must be an array of decks');
    return finish();
  }
  if (data.decks.length === 0) err('decks', 'is empty');
  if (authoring) {
    for (const key of Object.keys(data)) if (!['meta', 'decks'].includes(key)) warn(key, 'unknown top-level key (ignored by the app)');
  }

  const deckIds = new Set();
  const cardIds = new Set();

  data.decks.forEach((deck, d) => {
    const dw = `decks[${d}]`;
    if (!isObject(deck)) return err(dw, 'must be an object');
    stats.decks++;

    if (!isText(deck.id)) err(`${dw}.id`, 'is required and must be a non-empty string');
    else {
      if (deckIds.has(deck.id)) err(`${dw}.id`, `duplicate deck id ${label(deck.id)}`);
      deckIds.add(deck.id);
      if (!ID_PATTERN.test(deck.id)) authorErr(`${dw}.id`, `${label(deck.id)} must use only lowercase letters, digits, "_" and "-"`);
    }
    checkText(`${dw}.titel`, deck.titel, true);
    checkMeta(deck.meta, `${dw}.meta`);
    if (authoring) {
      for (const key of Object.keys(deck)) if (!['id', 'titel', 'meta', 'cards'].includes(key)) err(`${dw}.${key}`, 'unknown field');
    }

    if (!Array.isArray(deck.cards)) return err(`${dw}.cards`, 'is required and must be an array');
    if (deck.cards.length === 0) warn(`${dw}.cards`, 'deck has no cards');

    let trueCount = 0;
    let truefalseCount = 0;

    deck.cards.forEach((card, c) => {
      const cw = `${dw}.cards[${c}]`;
      if (!isObject(card)) return err(cw, 'must be an object');
      stats.cards++;

      if (!isText(card.id)) err(`${cw}.id`, 'is required and must be a non-empty string');
      else {
        // Card ids are the database key across ALL decks: a repeat silently overwrites a card.
        if (cardIds.has(card.id)) err(`${cw}.id`, `duplicate card id ${label(card.id)}; the later card would overwrite the earlier one`);
        cardIds.add(card.id);
        if (!ID_PATTERN.test(card.id)) authorErr(`${cw}.id`, `${label(card.id)} must use only lowercase letters, digits, "_" and "-"`);
        else if (isText(deck.id) && !card.id.startsWith(`${deck.id}_`)) {
          authorErr(`${cw}.id`, `${label(card.id)} must start with the deck id and an underscore ("${deck.id}_...") so ids stay unique across decks`);
        }
      }
      const at = isText(card.id) ? `${cw} (${card.id})` : cw;

      if (!CARD_TYPES.includes(card.type)) return err(`${at}.type`, `must be one of ${CARD_TYPES.join(', ')}; got ${label(card.type)}`);
      stats.byType[card.type] = (stats.byType[card.type] || 0) + 1;
      const spec = CARD_SPEC[card.type];

      if (card.tags !== undefined) {
        if (!Array.isArray(card.tags) || !card.tags.every(isText)) err(`${at}.tags`, 'must be an array of non-empty strings');
      }

      for (const key of spec.required) checkText(`${at}.${key}`, card[key], true);
      for (const key of spec.optional) checkText(`${at}.${key}`, card[key], false);

      if (card.type === 'cloze' && isText(card.text)) checkCloze(`${at}.text`, card.text);

      if (card.type === 'truefalse') {
        truefalseCount++;
        if (typeof card.answer !== 'boolean') err(`${at}.answer`, `must be the boolean true or false (not a string), got ${label(card.answer)}`);
        else if (card.answer) trueCount++;
        if (!isText(card.explanation)) warn(`${at}.explanation`, 'missing; the explanation is shown after answering and is where most learning happens');
      }
      if (card.type === 'cluster') checkCluster(at, card);

      if (card.progress !== undefined) checkProgress(`${at}.progress`, card.progress);
      if (authoring) {
        const allowed = ['id', 'type', 'tags', ...spec.required, ...spec.optional, ...(card.type === 'truefalse' ? ['answer'] : []), ...(card.type === 'cluster' ? ['items'] : [])];
        for (const key of Object.keys(card)) {
          if (key !== 'progress' && !allowed.includes(key)) err(`${at}.${key}`, `unknown field for a ${card.type} card; it would never be displayed`);
        }
      }
    });

    if (truefalseCount >= 6 && (trueCount / truefalseCount > 0.75 || trueCount / truefalseCount < 0.25)) {
      warn(`${dw}.cards`, `${trueCount} of ${truefalseCount} truefalse cards have answer true; balance them so the answer can't be guessed`);
    }
  });

  return finish();
}
