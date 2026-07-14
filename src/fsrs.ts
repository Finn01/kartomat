import { fsrs, createEmptyCard, Rating, State } from 'ts-fsrs';
import type { Card as FSRSCard, Grade } from 'ts-fsrs';
import type { CardProgress, FSRSSettings, ProgrammeSettings } from './types';
import { db } from './db';

// Default settings. `redrill_mode: 'spread'` / offset 3 reproduces the pre-navigation behaviour
// (a learning card re-shown ~3 cards later).
const DEFAULT_SETTINGS: FSRSSettings = {
  request_retention: 0.90,
  maximum_interval: 36500,
  redrill_mode: 'spread',
  redrill_offset: 3
};

/**
 * Retrieve FSRS Settings from LocalStorage or default.
 */
export function getFSRSSettings(): FSRSSettings {
  const stored = localStorage.getItem('fsrs_settings');
  if (!stored) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(stored);
    return {
      request_retention: typeof parsed.request_retention === 'number' ? parsed.request_retention : DEFAULT_SETTINGS.request_retention,
      maximum_interval: typeof parsed.maximum_interval === 'number' ? parsed.maximum_interval : DEFAULT_SETTINGS.maximum_interval,
      redrill_mode: parsed.redrill_mode === 'append' || parsed.redrill_mode === 'spread' ? parsed.redrill_mode : DEFAULT_SETTINGS.redrill_mode,
      // Clamp to a sane range; a broken/old value falls back to the default rather than NaN.
      redrill_offset: typeof parsed.redrill_offset === 'number' && parsed.redrill_offset >= 1
        ? Math.min(Math.floor(parsed.redrill_offset), 50)
        : DEFAULT_SETTINGS.redrill_offset
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Persists updated FSRS settings.
 */
export function saveFSRSSettings(settings: FSRSSettings) {
  localStorage.setItem('fsrs_settings', JSON.stringify(settings));
}

/**
 * Generates a configured ts-fsrs scheduler instance.
 */
export function getScheduler(customSettings?: FSRSSettings) {
  const settings = customSettings || getFSRSSettings();
  return fsrs({
    request_retention: settings.request_retention,
    maximum_interval: settings.maximum_interval
  });
}

/**
 * Derives FSRS settings based on Learning Programme specific settings.
 * Caps the maximum interval to the days remaining until a deadline (if enabled).
 */
export function deriveFSRSSettings(progSettings?: ProgrammeSettings): FSRSSettings {
  const globalSettings = getFSRSSettings();
  if (!progSettings) return globalSettings;

  let maxInterval = globalSettings.maximum_interval;
  if (progSettings.has_deadline && progSettings.deadline_date) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const deadline = new Date(progSettings.deadline_date);
    const deadlineDay = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());
    
    const msDiff = deadlineDay.getTime() - today.getTime();
    const daysDiff = Math.ceil(msDiff / (1000 * 60 * 60 * 24));
    
    maxInterval = Math.max(1, daysDiff);
  }

  return {
    request_retention: progSettings.target_retention,
    maximum_interval: maxInterval,
    // Re-drill behaviour is a global preference, not a per-programme one — carry it through.
    redrill_mode: globalSettings.redrill_mode,
    redrill_offset: globalSettings.redrill_offset
  };
}

/**
 * Map CardProgress database representation to ts-fsrs internal FSRSCard model.
 */
export function toFSRSCard(p: CardProgress): FSRSCard {
  const card = createEmptyCard();
  card.due = new Date(p.due);
  card.stability = p.stability;
  card.difficulty = p.difficulty;
  card.elapsed_days = p.elapsed_days;
  card.scheduled_days = p.scheduled_days;
  card.reps = p.reps;
  card.lapses = p.lapses;
  card.state = p.state as State;
  card.last_review = p.last_review ? new Date(p.last_review) : undefined;
  return card;
}

/**
 * Pre-populate a blank progress record for a newly imported/created card.
 */
export function createNewProgress(cardId: string, deckId: string): CardProgress {
  const empty = createEmptyCard();
  return {
    cardId,
    deckId,
    due: empty.due.toISOString(),
    stability: empty.stability,
    difficulty: empty.difficulty,
    elapsed_days: empty.elapsed_days,
    scheduled_days: empty.scheduled_days,
    reps: empty.reps,
    lapses: empty.lapses,
    state: empty.state as number,
    last_review: undefined
  };
}

/**
 * Formats time intervals dynamically for displaying intervals above grading buttons.
 */
export function formatInterval(scheduled_days: number): string {
  if (scheduled_days <= 0) {
    return 'now';
  }
  if (scheduled_days < 1) {
    // If interval is fractional (e.g. 10m is roughly 0.007 days), display in minutes or hours
    const minutes = Math.round(scheduled_days * 24 * 60);
    if (minutes < 1) return 'now';
    if (minutes < 60) {
      return `${minutes}m`;
    } else {
      const hours = Math.round(minutes / 60);
      return `${hours}h`;
    }
  }
  const days = Math.round(scheduled_days);
  if (days < 30) {
    return `${days}d`;
  }
  const months = Math.round(days / 30);
  if (months < 12) {
    return `${months}mo`;
  }
  return `${Math.round(days / 365)}y`;
}

/**
 * Computes next due intervals and dates for each of the four possible user grades.
 */
export function getNextReviewPreviews(progress: CardProgress, customSettings?: FSRSSettings): Record<Rating, { interval: string; date: string }> {
  const scheduler = getScheduler(customSettings);
  const fCard = toFSRSCard(progress);
  const now = new Date();
  
  const repeatResults = scheduler.repeat(fCard, now);
  const results = {} as Record<Rating, { interval: string; date: string }>;
  
  const ratings = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
  for (const r of ratings) {
    const outcome = repeatResults[r as Grade];
    results[r] = {
      interval: formatInterval(outcome.card.scheduled_days),
      date: outcome.card.due.toISOString()
    };
  }

  return results;
}

/**
 * Commits a card rating, recalculating its FSRS intervals, updating IndexedDB, and returning the result.
 */
export async function reviewCard(progress: CardProgress, rating: Rating, customSettings?: FSRSSettings): Promise<CardProgress> {
  const scheduler = getScheduler(customSettings);
  const fCard = toFSRSCard(progress);
  const now = new Date();
  
  const result = scheduler.next(fCard, now, rating as Grade);
  const updatedCard = result.card;

  const updatedProgress: CardProgress = {
    cardId: progress.cardId,
    deckId: progress.deckId,
    due: updatedCard.due.toISOString(),
    stability: updatedCard.stability,
    difficulty: updatedCard.difficulty,
    elapsed_days: updatedCard.elapsed_days,
    scheduled_days: updatedCard.scheduled_days,
    reps: updatedCard.reps,
    lapses: updatedCard.lapses,
    state: updatedCard.state as number,
    last_review: now.toISOString()
  };

  await db.progress.put(updatedProgress);
  return updatedProgress;
}
