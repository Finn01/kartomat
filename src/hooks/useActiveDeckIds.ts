import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Deck, Folder } from '../types';

/** A deck takes part in the main study programme unless it, or its folder, is switched off. */
export function isDeckActive(deck: Deck, folders: Folder[] | undefined): boolean {
  if (deck.active === false) return false;
  const folder = deck.folderId ? folders?.find(f => f.id === deck.folderId) : undefined;
  return folder?.active !== false;
}

/** IDs of every deck in the main study programme, or `undefined` while the DB is loading. */
export function useActiveDeckIds(): string[] | undefined {
  const decks = useLiveQuery(() => db.decks.toArray());
  const folders = useLiveQuery(() => db.folders.toArray());

  return useMemo(
    () => (decks && folders ? decks.filter(d => isDeckActive(d, folders)).map(d => d.id) : undefined),
    [decks, folders]
  );
}
