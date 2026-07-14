export interface Deck {
  id: string; // e.g. "vl01_aristoteles"
  titel: string;
  meta: {
    titel?: string;
    kurs?: string;
    quelle?: string;
    klausurformat?: string;
    hinweis_falschaussagen?: string;
    kartentypen?: Record<string, string>;
  };
  createdAt: number;
}

export type CardType = 'basic' | 'cloze' | 'truefalse' | 'correction' | 'cluster';

export interface BaseCard {
  id: string;
  deckId: string;
  type: CardType;
  tags: string[];
  createdAt: number;
}

export interface BasicCard extends BaseCard {
  type: 'basic';
  front: string;
  back: string;
}

export interface ClozeCard extends BaseCard {
  type: 'cloze';
  text: string;
  extra?: string;
}

export interface TrueFalseCard extends BaseCard {
  type: 'truefalse';
  statement: string;
  answer: boolean;
  explanation?: string;
}

export interface CorrectionCard extends BaseCard {
  type: 'correction';
  false_statement: string;
  correction: string;
}

export interface ClusterItem {
  label: string;
  statement: string;
  answer: boolean;
  explanation?: string;
}

export interface ClusterCard extends BaseCard {
  type: 'cluster';
  stem: string;
  items: ClusterItem[];
}

export type Flashcard = BasicCard | ClozeCard | TrueFalseCard | CorrectionCard | ClusterCard;

// DB progress tracking - extends or maps to FSRSCard
export interface CardProgress {
  cardId: string; // primary key
  deckId: string; // index for deck-specific filtering
  due: string;    // Date string (ISO)
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: number;  // FSRS state: 0=New, 1=Learning, 2=Review, 3=Relearning
  last_review?: string; // Date string (ISO)
}

export interface ProgrammeSettings {
  target_retention: number;
  has_deadline: boolean;
  deadline_date?: string;
}

export interface LearningProgramme {
  id: string;
  name: string;
  deckIds: string[];
  settings?: ProgrammeSettings;
  createdAt: number;
}

// How a learning card that hasn't graduated is re-queued for its next drill within a session:
//   - 'append': pushed to the end of the visit history (see farthest away).
//   - 'spread': spliced `redrill_offset` visits ahead of the current position (Anki-style short
//     step — re-shown soon while still fresh). Inserts only ever land *ahead* of the cursor, so
//     back-history stays stable (see StudySession's "semi-stable" navigation model).
export type RedrillMode = 'append' | 'spread';

export interface FSRSSettings {
  request_retention: number;
  maximum_interval: number;
  // Session re-drill behaviour. Not part of the ts-fsrs scheduler config — consumed only by the
  // StudySession queue — but stored alongside the scheduler settings for a single settings blob.
  redrill_mode: RedrillMode;
  redrill_offset: number; // cards ahead of the current one for 'spread' mode
}
