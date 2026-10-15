import template from './deckGuide.md?raw';
import validatorSource from './deckValidator.js?raw';

export const DECK_GUIDE_FILENAME = 'kartomat-deck-guide.md';

/**
 * The LLM authoring guide, assembled at download time. The validator embedded in it is this
 * build's own `deckValidator.js` source, so the guide can never describe rules the app's
 * importer doesn't actually enforce.
 */
export function buildDeckGuide(): string {
  // Replacer function: the validator source contains `$` sequences that a string replacement
  // would otherwise interpret.
  return template.replace('{{VALIDATOR_SOURCE}}', () => validatorSource.trim());
}
