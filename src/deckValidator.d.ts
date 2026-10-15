export const CARD_TYPES: readonly string[];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: { decks: number; cards: number; byType: Record<string, number> };
}

export function validateDeckFile(data: unknown, options?: { authoring?: boolean }): ValidationResult;
