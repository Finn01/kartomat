import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Deck, Flashcard, CardProgress, LearningProgramme } from './types';

export class KartomatDatabase extends Dexie {
  decks!: Table<Deck>;
  cards!: Table<Flashcard>;
  progress!: Table<CardProgress>;
  programmes!: Table<LearningProgramme>;

  constructor() {
    super('KartomatDatabase');
    this.version(1).stores({
      decks: 'id, createdAt',
      cards: 'id, deckId, type, createdAt',
      progress: 'cardId, deckId, due, state',
      programmes: 'id, createdAt'
    });
  }
}

export const db = new KartomatDatabase();

/**
 * Imports a JSON file containing decks and cards, updating card contents
 * and optionally importing or preserving spaced repetition progress states.
 */
export async function importDeckJson(parsedData: any) {
  const decksList = parsedData.decks || [];
  const meta = parsedData.meta || {};

  await db.transaction('rw', [db.decks, db.cards, db.progress], async () => {
    for (const deckData of decksList) {
      const deckId = deckData.id;
      const deckTitel = deckData.titel;
      
      const existingDeck = await db.decks.get(deckId);
      const deck: Deck = {
        id: deckId,
        titel: deckTitel,
        meta: {
          titel: meta.titel || deckData.meta?.titel,
          kurs: meta.kurs || deckData.meta?.kurs,
          quelle: meta.quelle || deckData.meta?.quelle,
          klausurformat: meta.klausurformat || deckData.meta?.klausurformat,
          hinweis_falschaussagen: meta.hinweis_falschaussagen || deckData.meta?.hinweis_falschaussagen,
          kartentypen: meta.kartentypen || deckData.meta?.kartentypen
        },
        createdAt: existingDeck?.createdAt || Date.now()
      };
      await db.decks.put(deck);

      const cardsList = deckData.cards || [];
      for (const cardData of cardsList) {
        // Clone card data but clean up helper variables
        const cleanCardData = { ...cardData };
        delete cleanCardData.progress;

        const card: Flashcard = {
          id: cardData.id,
          deckId: deckId,
          type: cardData.type,
          tags: cardData.tags || [],
          createdAt: Date.now(),
          ...cleanCardData
        };

        await db.cards.put(card);

        // If progress is present in the import JSON, overwrite.
        // Otherwise, do nothing to preserve existing local progress.
        if (cardData.progress) {
          const progress: CardProgress = {
            cardId: card.id,
            deckId: deckId,
            due: cardData.progress.due,
            stability: cardData.progress.stability,
            difficulty: cardData.progress.difficulty,
            elapsed_days: cardData.progress.elapsed_days,
            scheduled_days: cardData.progress.scheduled_days,
            reps: cardData.progress.reps,
            lapses: cardData.progress.lapses,
            state: cardData.progress.state,
            last_review: cardData.progress.last_review
          };
          await db.progress.put(progress);
        }
      }
    }
  });
}

/**
 * Exports the complete database (decks, cards, FSRS progress, and learning programmes)
 * as a single JSON backup.
 */
export async function exportBackupJson(): Promise<string> {
  const decks = await db.decks.toArray();
  const cards = await db.cards.toArray();
  const progressList = await db.progress.toArray();
  const programmes = await db.programmes.toArray();

  const backup = {
    exportDate: new Date().toISOString(),
    version: '1.0',
    decks: decks.map(d => {
      const deckCards = cards.filter(c => c.deckId === d.id);
      return {
        id: d.id,
        titel: d.titel,
        meta: d.meta,
        cards: deckCards.map(c => {
          const prog = progressList.find(p => p.cardId === c.id);
          return {
            ...c,
            progress: prog ? {
              due: prog.due,
              stability: prog.stability,
              difficulty: prog.difficulty,
              elapsed_days: prog.elapsed_days,
              scheduled_days: prog.scheduled_days,
              reps: prog.reps,
              lapses: prog.lapses,
              state: prog.state,
              last_review: prog.last_review
            } : undefined
          };
        })
      };
    }),
    learning_programmes: programmes
  };

  return JSON.stringify(backup, null, 2);
}

/**
 * Restores the complete database from an exported backup JSON.
 */
export async function restoreBackupJson(backupData: any) {
  const decksList = backupData.decks || [];
  const programmes = backupData.learning_programmes || [];

  await db.transaction('rw', [db.decks, db.cards, db.progress, db.programmes], async () => {
    // Clear existing data to ensure full restore
    await db.decks.clear();
    await db.cards.clear();
    await db.progress.clear();
    await db.programmes.clear();

    for (const deckData of decksList) {
      const deck: Deck = {
        id: deckData.id,
        titel: deckData.titel,
        meta: deckData.meta || {},
        createdAt: Date.now()
      };
      await db.decks.put(deck);

      const cardsList = deckData.cards || [];
      for (const cardData of cardsList) {
        const cleanCardData = { ...cardData };
        delete cleanCardData.progress;

        const card: Flashcard = {
          id: cardData.id,
          deckId: deckData.id,
          type: cardData.type,
          tags: cardData.tags || [],
          createdAt: Date.now(),
          ...cleanCardData
        };
        await db.cards.put(card);

        if (cardData.progress) {
          const progress: CardProgress = {
            cardId: card.id,
            deckId: deckData.id,
            due: cardData.progress.due,
            stability: cardData.progress.stability,
            difficulty: cardData.progress.difficulty,
            elapsed_days: cardData.progress.elapsed_days,
            scheduled_days: cardData.progress.scheduled_days,
            reps: cardData.progress.reps,
            lapses: cardData.progress.lapses,
            state: cardData.progress.state,
            last_review: cardData.progress.last_review
          };
          await db.progress.put(progress);
        }
      }
    }

    for (const prog of programmes) {
      await db.programmes.put({
        id: prog.id,
        name: prog.name,
        deckIds: prog.deckIds || [],
        createdAt: prog.createdAt || Date.now()
      });
    }
  });
}

/**
 * Exports a specific deck (cards content and optional study progress) as a JSON string.
 */
export async function exportDeckJson(deckId: string, includeProgress: boolean): Promise<string> {
  const deck = await db.decks.get(deckId);
  if (!deck) {
    throw new Error(`Deck not found: ${deckId}`);
  }

  const cards = await db.cards.where('deckId').equals(deckId).toArray();
  const progressList = includeProgress ? await db.progress.where('deckId').equals(deckId).toArray() : [];

  const exportObj = {
    meta: {
      titel: deck.meta.titel || deck.titel,
      kurs: deck.meta.kurs,
      quelle: deck.meta.quelle,
      klausurformat: deck.meta.klausurformat,
      hinweis_falschaussagen: deck.meta.hinweis_falschaussagen,
      kartentypen: deck.meta.kartentypen
    },
    decks: [
      {
        id: deck.id,
        titel: deck.titel,
        cards: cards.map(c => {
          const prog = progressList.find(p => p.cardId === c.id);
          return {
            ...c,
            progress: prog ? {
              due: prog.due,
              stability: prog.stability,
              difficulty: prog.difficulty,
              elapsed_days: prog.elapsed_days,
              scheduled_days: prog.scheduled_days,
              reps: prog.reps,
              lapses: prog.lapses,
              state: prog.state,
              last_review: prog.last_review
            } : undefined
          };
        })
      }
    ]
  };

  return JSON.stringify(exportObj, null, 2);
}


