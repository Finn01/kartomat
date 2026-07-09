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

export interface FSRSSettings {
  request_retention: number;
  maximum_interval: number;
}
