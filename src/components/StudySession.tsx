import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Flashcard, CardProgress, FSRSSettings } from '../types';
import { Rating, State } from 'ts-fsrs';
import { reviewCard, createNewProgress, getNextReviewPreviews, getFSRSSettings } from '../fsrs';
import { X, Check, Eye, CheckCircle2, Clock, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';

interface StudySessionProps {
  deckIds: string[] | null; // null means global study (all decks)
  customFSRSSettings?: FSRSSettings;
  onClose: () => void;
}

// A single stop in the session's visit history. `visitId` is stable and unique even when the same
// card is re-drilled (a learning card that didn't graduate is appended as a *new* visit), so
// back/forward navigation and the per-visit rating/working-state maps have a reliable key.
interface SessionQueueItem {
  visitId: string;
  card: Flashcard;
  progress: CardProgress;
}

// The outcome recorded when a card is rated. Its presence in `answers` means the visit is locked;
// ratings are final EXCEPT via the 3-second Undo of the single most recent rating. We keep the
// interactive selections + reveal flag so navigating back restores exactly what the card looked
// like, `autoAgain` so the UI can explain a forced rating, and enough to fully revert the commit:
// the pre-review FSRS progress, whether it graduated (to undo the completed count), and the id of
// any re-drill visit it spawned (to splice back out on undo).
interface RecordedAnswer {
  rating: Rating;
  tfSelection: boolean | null;
  clusterSelections: Record<number, boolean>;
  showAnswer: boolean;
  autoAgain: boolean;
  prevProgress: CardProgress; // pre-review snapshot, restored to IndexedDB on undo
  graduated: boolean;
  redrillVisitId: string | null; // the re-drill this rating appended, if any
}

// The editable in-progress state for a not-yet-rated (skipped/deferred) visit, kept per visit so
// that leaving a half-answered card and coming back preserves the reveal + selections.
interface WorkingState {
  showAnswer: boolean;
  tfSelection: boolean | null;
  clusterSelections: Record<number, boolean>;
}

const EMPTY_WORKING: WorkingState = { showAnswer: false, tfSelection: null, clusterSelections: {} };

// Snapshot of the card being flicked away so the animation is immune to queue changes underneath.
interface FlickSnapshot {
  item: SessionQueueItem;
  tfSelection: boolean | null;
  clusterSelections: Record<number, boolean>;
  color: string;
  height: number | null;
  graduated: boolean;
}

// Options controlling how a single card face is rendered (shared by the live card and the flick
// overlay). Rating buttons no longer live inside the card — they are in the persistent bottom
// control bar — so this only covers the card's own content, its interactive selections, and the
// "Show Answer" reveal.
interface CardFaceOptions {
  showAnswer: boolean;
  tfSelection: boolean | null;
  clusterSelections: Record<number, boolean>;
  setTfSelection: (value: boolean) => void;
  setClusterSelection: (idx: number, value: boolean) => void;
  onReveal: () => void;
  disabled: boolean;
}

const FLICK_DURATION_MS = 500;

// Maps a rating (or a wrong interactive answer) to the recall-difficulty colour used for the flick border.
const flickColor = (rating: Rating, incorrect: boolean): string => {
  if (incorrect || rating === Rating.Again) return 'var(--color-again)';
  if (rating === Rating.Hard) return 'var(--color-hard)';
  if (rating === Rating.Good) return 'var(--color-good)';
  return 'var(--color-easy)';
};

export const StudySession: React.FC<StudySessionProps> = ({ deckIds, customFSRSSettings, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [queue, setQueue] = useState<SessionQueueItem[]>([]);
  // Stateful cursor into the visit history (was hard-coded to 0 when the queue was a live stack).
  // Back/forward move this; rating auto-advances it. Always kept within [0, queue.length - 1].
  const [currentIdx, setCurrentIdx] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [sessionReviewedCount, setSessionReviewedCount] = useState(0);

  // Re-drill placement for learning cards. Comes from global settings (per the product decision);
  // customFSRSSettings already carries these through deriveFSRSSettings, and we fall back to the
  // stored global settings when no per-programme override is supplied. Captured once at session
  // start (in a state initializer) so it doesn't re-read localStorage every render, and so a
  // mid-session settings change can't shift placement halfway through.
  const [redrillSettings] = useState(() => customFSRSSettings ?? getFSRSSettings());
  const redrillMode = redrillSettings.redrill_mode;
  const redrillOffset = redrillSettings.redrill_offset;

  // Write-once outcomes, keyed by visitId. Presence = the visit is rated and locked.
  const [answers, setAnswers] = useState<Record<string, RecordedAnswer>>({});
  // Editable in-progress state for not-yet-rated visits, keyed by visitId. A visit missing from
  // this map defaults to EMPTY_WORKING (fresh, answer hidden).
  const [working, setWorking] = useState<Record<string, WorkingState>>({});
  // Monotonic counter for minting unique visitIds when a learning card is re-drilled.
  const redrillSeqRef = useRef(0);

  // Undo affordance: the visitId of the single most recent rating, offered for a 3s window during
  // which the Back button becomes "Undo". Cleared on timeout, on the next rating, or on navigation.
  const [undoVisitId, setUndoVisitId] = useState<string | null>(null);
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0); // countdown shown on the Undo button
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const UNDO_WINDOW_MS = 3000;

  // Drive the visible 3→1 countdown while an undo offer is open. Purely cosmetic; the authoritative
  // expiry is the timeout armed in handleRate.
  useEffect(() => {
    if (!undoVisitId) return;
    setUndoSecondsLeft(Math.ceil(UNDO_WINDOW_MS / 1000));
    const started = Date.now();
    const id = setInterval(() => {
      const remainingMs = UNDO_WINDOW_MS - (Date.now() - started);
      setUndoSecondsLeft(Math.max(0, Math.ceil(remainingMs / 1000)));
    }, 250);
    return () => clearInterval(id);
  }, [undoVisitId]);

  // Clear the undo timeout if the session unmounts mid-window so it can't fire after teardown.
  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);
  // When true, review cards that aren't due yet are pulled into the queue too (opt-in "study
  // ahead" for when nothing is currently scheduled). Never affects new-card selection, which is
  // already included regardless of due dates.
  const [studyAhead, setStudyAhead] = useState(false);
  // Whether any not-yet-due review cards exist at all, so we know whether "Study ahead" has
  // anything to offer (kept separate from `queue` so it survives the due-only filtering).
  const [hasUpcomingCards, setHasUpcomingCards] = useState(false);

  // Completion animation state (the card currently being flicked off the deck)
  const [flicking, setFlicking] = useState<FlickSnapshot | null>(null);
  // Reverse-flick state: on Undo the card flies back *in* from whichever side it left, using the
  // same snapshot (its `graduated` flag encodes the side). Cleared once the animation has played.
  const [flickingBack, setFlickingBack] = useState<FlickSnapshot | null>(null);
  // Synchronous re-entrancy guard for handleRate: `flicking` state doesn't commit until the
  // next render, so a rapid double-click/double-tap could otherwise slip past that check.
  const ratingInFlightRef = useRef(false);

  // Measure the sticky header so the card can be sized to fit the viewport beneath it.
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(72);

  // Measure the fixed bottom control bar (rating buttons + Back/Forward) so the card is sized to
  // sit above it — the card and the controls must never overlap. Its offsetHeight already includes
  // its own safe-area bottom padding, so reserving it also clears the home indicator.
  const footerRef = useRef<HTMLDivElement>(null);
  const [footerHeight, setFooterHeight] = useState(148);

  // The card wrapper's top edge in viewport coordinates. Measured rather than derived, so the card
  // sizing stays correct no matter what sits above it (sticky header, the overlay container's
  // safe-area top padding under viewport-fit=cover, etc.) — hardcoding that stack was what let the
  // card run under the control bar.
  const cardWrapperRef = useRef<HTMLDivElement>(null);
  const [cardWrapperTop, setCardWrapperTop] = useState(120);

  // Track viewport height numerically (in addition to the CSS dvh clamp) so we can cap the
  // animated card height in JS — animating toward a value beyond the CSS max-height would be
  // clipped instantly with no visible transition.
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const update = () => setViewportHeight(window.visualViewport?.height ?? window.innerHeight);
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);

  // Reference to the live card so we can freeze its height while it flicks away.
  const baseCardRef = useRef<HTMLDivElement>(null);

  // Measure the card's natural content height so we can animate growth (e.g. on answer reveal)
  // as a smooth downward extension instead of an instant layout jump.
  const cardContentRef = useRef<HTMLDivElement>(null);
  const [cardContentHeight, setCardContentHeight] = useState<number | null>(null);
  const [skipHeightAnim, setSkipHeightAnim] = useState(true);

  // Query database in raw format (we'll process this once on mount/deck change)
  const allCards = useLiveQuery(() => db.cards.toArray());
  const allProgress = useLiveQuery(() => db.progress.toArray());

  // The queue is built exactly once per (deck selection × studyAhead) — captured here so that
  // subsequent `allProgress` changes (fired by every `reviewCard()` write) do NOT rebuild it out
  // from under the running session. Once built, the queue is owned solely by `handleRate`, which
  // splices completed cards out and re-queues "Again" cards. Rebuilding on every DB write is what
  // used to desync the Remaining/Completed counters and re-inject just-completed learning cards
  // (a "Good"-rated new card is due again in ~10 min, i.e. `due <= now`, so it kept coming back).
  const queueBuiltRef = useRef(false);

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () => setHeaderHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  // Measure the fixed control bar; its height feeds the card-sizing math so content never sits
  // under the controls. Re-measures on resize (button labels/intervals can change its height).
  useLayoutEffect(() => {
    const el = footerRef.current;
    if (!el) return;
    const update = () => setFooterHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  // Measure where the card actually starts. Re-runs whenever anything above it could have moved
  // (header resize, viewport/orientation change), which is all that determines this position — the
  // card's own height never feeds back into it, so there's no measurement loop.
  useLayoutEffect(() => {
    const el = cardWrapperRef.current;
    if (!el) return;
    setCardWrapperTop(el.getBoundingClientRect().top);
  }, [loading, headerHeight, viewportHeight]);

  // The current visit's stable id — drives the height-snap effect below (a new card mounting)
  // and, further down, the derived per-visit view state.
  const activeVisitId = queue[currentIdx]?.visitId ?? null;

  // Track the live card's natural content height and mirror it onto the outer card as an
  // animated `height`, so growth (e.g. revealing the answer) reads as a fluid downward
  // extension rather than an instant jump. Height changes triggered by swapping to a new
  // card are applied without animation (see skipHeightAnim).
  useLayoutEffect(() => {
    const el = cardContentRef.current;
    if (!el) {
      setCardContentHeight(null);
      return;
    }
    // A new card just mounted: snap to its size instead of animating from the old card's height.
    setSkipHeightAnim(true);
    const update = () => setCardContentHeight(el.offsetHeight);
    update();
    // Re-enable the grow/shrink animation once the initial size has been applied.
    const enableAnim = requestAnimationFrame(() => setSkipHeightAnim(false));
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(enableAnim);
    };
  }, [activeVisitId]);

  // Rebuild the queue only when the *inputs that define the session* change (deck selection or
  // the study-ahead toggle) — not on every progress write. This guard is reset in that effect's
  // dependency, so toggling "Study ahead" mid-session re-derives the queue as intended.
  useEffect(() => {
    queueBuiltRef.current = false;
  }, [deckIds, studyAhead]);

  useEffect(() => {
    if (!allCards || !allProgress) return;
    // Already built for this deck/studyAhead combination — leave the live queue alone so that
    // `handleRate` remains the single owner of queue mutations.
    if (queueBuiltRef.current) return;

    const prepareQueue = async () => {
      // 1. Filter cards by selected decks
      const filteredCards = deckIds
        ? allCards.filter(c => deckIds.includes(c.deckId))
        : allCards;

      const now = new Date();
      const dueItems: SessionQueueItem[] = [];
      const upcomingItems: SessionQueueItem[] = []; // not yet due — only studied via "Study ahead"
      const newItems: SessionQueueItem[] = [];

      for (const card of filteredCards) {
        let prog = allProgress.find(p => p.cardId === card.id);

        // Each card appears at most once in the initial queue, so keying its first visit off the
        // card id is unique. Re-drilled learning cards mint fresh ids (see handleRate).
        const visitId = `v0:${card.id}`;

        if (!prog) {
          // It's a new card, create new progress but don't save to DB until reviewed
          prog = createNewProgress(card.id, card.deckId);
          newItems.push({ visitId, card, progress: prog });
        } else {
          const isDue = new Date(prog.due) <= now;
          if (isDue) {
            dueItems.push({ visitId, card, progress: prog });
          } else {
            upcomingItems.push({ visitId, card, progress: prog });
          }
        }
      }

      setHasUpcomingCards(upcomingItems.length > 0);

      // Sort due items in line with FSRS/SR learning standards:
      // 1. Learning/Relearning cards (states 1 and 3) that are due should be prioritized and sorted by due date ascending (most urgent first).
      // 2. Review cards (state 2 or others) that are due should be sorted by due date ascending (most overdue first).
      // 3. New cards should be shown last.
      const dueLearning = dueItems
        .filter(item => item.progress.state === 1 || item.progress.state === 3)
        .sort((a, b) => new Date(a.progress.due).getTime() - new Date(b.progress.due).getTime());

      const dueReview = dueItems
        .filter(item => item.progress.state !== 1 && item.progress.state !== 3)
        .sort((a, b) => new Date(a.progress.due).getTime() - new Date(b.progress.due).getTime());

      const shuffle = <T,>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5);
      const shuffledNew = shuffle(newItems).slice(0, 15);

      // "Study ahead": pull in not-yet-due review cards too, soonest-due first (least early —
      // and therefore least likely to distort FSRS's stability estimate — reviewed first).
      const aheadReview = studyAhead
        ? [...upcomingItems].sort((a, b) => new Date(a.progress.due).getTime() - new Date(b.progress.due).getTime())
        : [];

      // Arm the guard so that subsequent `allProgress` writes (from every `reviewCard()`) don't
      // rebuild the queue — from here on `handleRate` is its sole owner. Set before the state
      // updates below so the effect can't re-enter and rebuild in the meantime.
      queueBuiltRef.current = true;
      setQueue([...dueLearning, ...dueReview, ...shuffledNew, ...aheadReview]);
      setLoading(false);
    };

    prepareQueue();
  }, [allCards, allProgress, deckIds, studyAhead]);

  if (loading) {
    return (
      <div className="glass-panel" style={{ padding: '60px 20px', textAlign: 'center', margin: '40px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
        <div style={{ width: '40px', height: '40px', border: '3px solid rgba(255,255,255,0.1)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <p style={{ color: 'var(--text-secondary)' }}>Preparing card deck...</p>
        <style>{`
          @keyframes spin { to { transform: rotate(360deg); } }
        `}</style>
      </div>
    );
  }

  // The session is finished once every visit in the queue has been rated (write-once). Skipped
  // (deferred) cards keep the session open — a skip defers a card, it never dismisses it — and
  // re-drilled learning cards are appended as fresh unrated visits, so "all visits rated" is the
  // single, drift-free completion signal.
  const allRated = queue.length > 0 && queue.every(item => answers[item.visitId] !== undefined);

  // Handle empty queue / fully-rated session — but let a final flick finish playing first, and keep
  // the session UI up while an undo offer is open so the *last* rating stays undoable (the
  // completion screen would otherwise hide the Undo button).
  if ((queue.length === 0 || allRated) && !flicking && !undoVisitId) {
    // Nothing was ever reviewed this session: either the deck had nothing due to begin with,
    // or "Study ahead" is on but everything upcoming has now been reviewed too.
    if (sessionReviewedCount === 0) {
      return (
        <div className="glass-panel" style={{ padding: '48px 24px', textAlign: 'center', margin: '40px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
          <div style={{ padding: '16px', borderRadius: '50%', background: 'rgba(59, 130, 246, 0.1)', color: 'var(--color-secondary)' }}>
            <Clock size={44} />
          </div>
          <div>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '8px' }}>Nothing Scheduled</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', maxWidth: '400px', margin: '0 auto', lineHeight: '1.4' }}>
              {studyAhead
                ? "You've reviewed everything available, including cards not yet due."
                : 'No flashcards are due for review right now. Check back later, or study ahead if you want to get a head start.'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
            {!studyAhead && hasUpcomingCards && (
              <button className="btn" onClick={() => setStudyAhead(true)}>
                Study Ahead
              </button>
            )}
            <button className="btn btn-primary" onClick={onClose}>
              Return to Dashboard
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="glass-panel" style={{ padding: '48px 24px', textAlign: 'center', margin: '40px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
        <div style={{ padding: '16px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.1)', color: 'var(--color-good)' }}>
          <CheckCircle2 size={44} />
        </div>
        <div>
          <h2 style={{ fontSize: '1.4rem', marginBottom: '8px' }}>Session Complete!</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', maxWidth: '400px', margin: '0 auto', lineHeight: '1.4' }}>
            Excellent job! You completed {completedCount} {completedCount === 1 ? 'card' : 'cards'} in this session{sessionReviewedCount !== completedCount ? ` across ${sessionReviewedCount} reviews` : ''}. All cards have been scheduled for their next intervals.
          </p>
        </div>
        <button className="btn btn-primary" onClick={onClose}>
          Return to Dashboard
        </button>
      </div>
    );
  }

  const currentItem = queue[currentIdx] ?? null;
  const currentVisitId = currentItem?.visitId ?? '';
  const recorded = currentItem ? answers[currentVisitId] : undefined;
  const isLocked = recorded !== undefined;

  // View state for the current visit is derived: a rated visit renders its frozen recorded state,
  // an un-rated visit its editable working state (default: answer hidden). A card can now be rated
  // without revealing, so a locked visit restores whatever reveal state it had at rating time.
  const workingState = working[currentVisitId] ?? EMPTY_WORKING;
  const showAnswer = isLocked ? recorded.showAnswer : workingState.showAnswer;
  const tfSelection = isLocked ? recorded.tfSelection : workingState.tfSelection;
  const clusterSelections = isLocked ? recorded.clusterSelections : workingState.clusterSelections;

  // Mutate the current visit's working state (no-op once locked — ratings are final).
  const patchWorking = (patch: Partial<WorkingState>) => {
    if (isLocked) return;
    setWorking(prev => ({
      ...prev,
      [currentVisitId]: { ...(prev[currentVisitId] ?? EMPTY_WORKING), ...patch },
    }));
  };

  const handleReveal = () => patchWorking({ showAnswer: true });
  const setTfSelection = (value: boolean) => patchWorking({ tfSelection: value });
  const setClusterSelection = (idx: number, value: boolean) =>
    patchWorking({ clusterSelections: { ...clusterSelections, [idx]: value } });

  // Cancel the pending undo offer (timer + flag). Called on navigation, on the next rating, and
  // after an undo is performed, so only the single latest rating is ever undoable.
  const clearUndo = () => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoVisitId(null);
  };

  const goBack = () => {
    clearUndo();
    if (currentIdx > 0) setCurrentIdx(currentIdx - 1);
  };
  const goForward = () => {
    clearUndo();
    if (currentIdx < queue.length - 1) setCurrentIdx(currentIdx + 1);
  };

  const handleRate = async (rating: Rating) => {
    // Ignore ratings while a flick is in flight or the visit is already locked. The ref guard is
    // synchronous so a rapid double-tap can't slip past before `flicking` state commits.
    if (flicking || ratingInFlightRef.current || isLocked || !currentItem) return;
    ratingInFlightRef.current = true;

    const item = currentItem;
    const { card, progress, visitId } = item;

    // Rating a new card supersedes any pending undo — only the latest rating is ever undoable.
    clearUndo();

    // An interactive card that was *answered* incorrectly forces "Again" (unanswered does not —
    // then the user is self-grading, and their pressed rating stands). Mirrors `forcedAgain` above.
    let autoAgain = false;
    if (card.type === 'truefalse') {
      autoAgain = tfSelection !== null && tfSelection !== card.answer;
    } else if (card.type === 'cluster') {
      const fullyAnswered = card.items.every((_, idx) => clusterSelections[idx] !== undefined);
      autoAgain = fullyAnswered && card.items.some((clItem, idx) => clusterSelections[idx] !== clItem.answer);
    }
    // A wrong interactive answer is always committed as "Again", regardless of which button fired
    // this call — the UI blocks the others, and coercing here keeps the DB honest even so.
    const effectiveRating = autoAgain ? Rating.Again : rating;

    // 1. Commit rating to IndexedDB. `progress` is the pre-review snapshot — we stash it in the
    //    recorded answer so Undo can restore it (this is the one sanctioned re-write of progress).
    const updatedProgress = await reviewCard(progress, effectiveRating, customFSRSSettings);
    setSessionReviewedCount(prev => prev + 1);

    // A card only *completes* (leaves the learning loop) once FSRS moves it into the Review state.
    const hasGraduated = updatedProgress.state === State.Review;

    // 2. Snapshot the outgoing card so the flick animation is immune to the swap beneath it.
    setFlicking({
      item,
      tfSelection,
      clusterSelections,
      color: flickColor(effectiveRating, autoAgain),
      height: baseCardRef.current?.offsetHeight ?? null,
      graduated: hasGraduated,
    });

    // 3. Spaced-repetition re-handling — Anki-style learning steps.
    // A card graduates (leaves the learning loop) once FSRS moves it into the Review state, i.e.
    // it's scheduled a real interval away. While still Learning/Relearning it must be re-drilled,
    // which we do by inserting a fresh unrated visit of the same card *ahead of the current cursor*.
    // Placement follows the re-drill setting: 'append' pushes to the end, 'spread' splices
    // `redrillOffset` cards ahead. Inserting only ahead of `currentIdx` keeps the back-history
    // stable (the "semi-stable" model: fixed past, moving future). The just-rated visit stays
    // locked in place; the new visit is what gets re-answered. `completedCount` counts graduations.
    //
    // We build the projected queue locally (rather than only inside the setQueue updater) so the
    // advance in step 5 can reason about the exact same post-insert list and the just-rated card.
    let redrillInsertIdx = -1;
    let redrillVisitId: string | null = null;
    let projectedQueue = queue;
    if (hasGraduated) {
      setCompletedCount(prev => prev + 1);
    } else {
      redrillVisitId = `r${redrillSeqRef.current++}:${card.id}`;
      const newVisit: SessionQueueItem = { visitId: redrillVisitId, card, progress: updatedProgress };
      redrillInsertIdx = redrillMode === 'append'
        ? queue.length
        : Math.min(queue.length, Math.max(currentIdx + redrillOffset, currentIdx + 1));
      projectedQueue = [...queue];
      projectedQueue.splice(redrillInsertIdx, 0, newVisit);
      setQueue(projectedQueue);
    }

    // 4. Record the outcome, locking this visit. Carries everything Undo needs: the pre-review
    //    progress, the reveal/selection state to restore, whether it graduated, and any re-drill id.
    setAnswers(prev => ({
      ...prev,
      [visitId]: {
        rating: effectiveRating,
        tfSelection,
        clusterSelections,
        showAnswer,
        autoAgain,
        prevProgress: progress,
        graduated: hasGraduated,
        redrillVisitId,
      },
    }));

    // 5. Advance to the next card that still needs a rating. "Needs a rating" = not in `answers`
    //    (which predates this write, so we also exclude the just-rated `visitId`) and not the
    //    freshly inserted re-drill's own slot... which we *want* to land on, so it's treated as
    //    unrated. We search forward from the cursor first (preserving momentum and keeping Back
    //    available), then wrap to sweep up earlier skipped cards. If nothing is left unrated the
    //    cursor holds and the completion screen takes over.
    const isUnrated = (idx: number): boolean => {
      if (idx === redrillInsertIdx) return true; // the new re-drill is unrated by construction
      const q = projectedQueue[idx];
      return q.visitId !== visitId && answers[q.visitId] === undefined;
    };
    setCurrentIdx(prevIdx => {
      for (let idx = prevIdx + 1; idx < projectedQueue.length; idx++) {
        if (isUnrated(idx)) return idx;
      }
      for (let idx = 0; idx <= prevIdx && idx < projectedQueue.length; idx++) {
        if (isUnrated(idx)) return idx;
      }
      return prevIdx; // nothing left unrated — completion screen takes over
    });

    // 6. The commit + queue updates are done, so release the rate re-entrancy guard *now* — this is
    //    what lets Undo act instantly, even while the flick below is still playing (a new *rating*
    //    is still blocked meanwhile by the `flicking` check at the top of handleRate). The flick
    //    snapshot itself is cleared only once its animation has finished.
    ratingInFlightRef.current = false;
    setTimeout(() => setFlicking(null), FLICK_DURATION_MS);

    // 7. Open the 3-second Undo window on this rating (the Back button becomes "Undo"). The timer
    //    just retires the offer; the actual revert lives in handleUndo.
    setUndoVisitId(visitId);
    undoTimerRef.current = setTimeout(() => {
      undoTimerRef.current = null;
      setUndoVisitId(null);
    }, UNDO_WINDOW_MS);
  };

  // Fully revert the most recent rating (only available during its 3s window). Undoes every effect
  // of that handleRate call: restores the pre-review FSRS progress in IndexedDB, removes the
  // re-drill it spawned, unlocks the visit, rolls back the counters, and returns the cursor to it.
  // Usable instantly — even while the outbound flick is still playing — so it does NOT gate on
  // `flicking`; only the true commit-in-progress lock (`ratingInFlightRef`) blocks it.
  const handleUndo = async () => {
    if (ratingInFlightRef.current) return;
    const targetId = undoVisitId;
    if (!targetId) return;
    const rec = answers[targetId];
    if (!rec) {
      clearUndo();
      return;
    }
    clearUndo();

    // Build the reverse-flick snapshot before mutating state. Reuse the live outbound snapshot if
    // it's still on screen (undo pressed mid-flick); otherwise reconstruct from the recorded answer
    // and the card in the queue. Either way `graduated` encodes which side it left toward.
    const undoneItem = queue.find(q => q.visitId === targetId);
    const backSnapshot: FlickSnapshot | null =
      flicking && flicking.item.visitId === targetId
        ? flicking
        : undoneItem
        ? {
            item: undoneItem,
            tfSelection: rec.tfSelection,
            clusterSelections: rec.clusterSelections,
            color: flickColor(rec.rating, rec.autoAgain),
            height: baseCardRef.current?.offsetHeight ?? null,
            graduated: rec.graduated,
          }
        : null;

    // Interrupt any outbound flick still in flight so it doesn't linger over the returning card.
    setFlicking(null);
    ratingInFlightRef.current = false;

    // 1. Restore the pre-review FSRS state. A card that was brand-new before this rating had no
    //    persisted progress row (its snapshot came from createNewProgress, never written); delete
    //    the row so it returns to truly-new rather than leaving a synthetic New-state record.
    const wasNew = rec.prevProgress.reps === 0 && rec.prevProgress.last_review === undefined;
    if (wasNew) {
      await db.progress.delete(rec.prevProgress.cardId);
    } else {
      await db.progress.put(rec.prevProgress);
    }

    // 2. Roll back the session counters.
    setSessionReviewedCount(prev => Math.max(0, prev - 1));
    if (rec.graduated) setCompletedCount(prev => Math.max(0, prev - 1));

    // 3. Unlock the visit.
    setAnswers(prev => {
      const next = { ...prev };
      delete next[targetId];
      return next;
    });

    // 4. Remove the re-drill this rating spawned (if any), then point the cursor at the just-undone
    //    card. Its position is stable — inserts only ever land ahead of it and no rating happened
    //    after it (rating clears the undo) — so we locate it by id in the post-removal queue.
    const nextQueue = rec.redrillVisitId
      ? queue.filter(q => q.visitId !== rec.redrillVisitId)
      : queue;
    if (rec.redrillVisitId) setQueue(nextQueue);
    const idx = nextQueue.findIndex(q => q.visitId === targetId);
    if (idx !== -1) setCurrentIdx(idx);

    // 5. Play the reverse flick: the card flies back in from the side it left. The live card is
    //    already the undone card underneath, so this overlay just animates the return over it.
    if (backSnapshot) {
      setFlickingBack(backSnapshot);
      setTimeout(() => setFlickingBack(null), FLICK_DURATION_MS);
    }
  };

  // Helper to parse and render Cloze front/back
  const renderClozeText = (text: string, reveal: boolean) => {
    const parts = text.split(/(\{\{c\d+::.*?\}\})/g);
    return parts.map((part, index) => {
      const match = part.match(/\{\{c\d+::(.*)\}\}/);
      if (match) {
        const answer = match[1];
        if (reveal) {
          return <span key={index} className="cloze-revealed">{answer}</span>;
        } else {
          return <span key={index} className="cloze-blank">[...]</span>;
        }
      }
      return part;
    });
  };

  // Renders the header + body + footer of a single card, parameterised so it can back both the
  // live interactive card and the frozen snapshot that flicks off the deck.
  const renderCardFace = (item: SessionQueueItem, opts: CardFaceOptions) => {
    const { card } = item;
    const { showAnswer: reveal, tfSelection: tf, clusterSelections: clusters } = opts;

    return (
      <>
        {/* Card Header (Meta, Type, Tags) */}
        <div className="card-header">
          <span className="card-type-badge">{card.type}</span>
          <div className="card-tags">
            {card.tags.map((t, idx) => (
              <span key={idx} className="card-tag">{t}</span>
            ))}
          </div>
        </div>

        {/* Card Content Body */}
        <div className="card-body">

          {/* 1. BASIC CARD */}
          {card.type === 'basic' && (
            <>
              <p className="card-question">{card.front}</p>
              {reveal && (
                <>
                  <div className="card-answer-separator" />
                  <p className="card-answer">{card.back}</p>
                </>
              )}
            </>
          )}

          {/* 2. CLOZE CARD */}
          {card.type === 'cloze' && (
            <>
              <p className="card-question" style={{ fontSize: '1.25rem', textAlign: 'left', lineHeight: '1.6' }}>
                {renderClozeText(card.text, reveal)}
              </p>
              {reveal && card.extra && (
                <>
                  <div className="card-answer-separator" />
                  <div style={{ background: 'rgba(255,255,255,0.02)', padding: '12px 16px', borderRadius: '12px', border: '1px solid var(--border-color)', fontSize: '0.88rem', color: 'var(--text-muted)', textAlign: 'left', lineHeight: '1.5' }}>
                    <strong style={{ color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Extra Explanation:</strong>
                    {card.extra}
                  </div>
                </>
              )}
            </>
          )}

          {/* 3. TRUE / FALSE CARD */}
          {card.type === 'truefalse' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', textAlign: 'left' }}>
              <p className="card-question">{card.statement}</p>

              {/* User Input Selection */}
              <div style={{ display: 'flex', gap: '12px', marginTop: '10px' }}>
                <button
                  disabled={reveal || opts.disabled}
                  onClick={() => opts.setTfSelection(true)}
                  className="btn"
                  style={{
                    flex: 1,
                    background: tf === true ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255,255,255,0.02)',
                    borderColor: tf === true ? 'var(--color-good)' : 'var(--border-color)',
                    color: tf === true ? 'var(--color-good)' : 'var(--text-primary)',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                  }}
                >
                  Ja / Wahr (True)
                </button>
                <button
                  disabled={reveal || opts.disabled}
                  onClick={() => opts.setTfSelection(false)}
                  className="btn"
                  style={{
                    flex: 1,
                    background: tf === false ? 'rgba(244, 63, 94, 0.15)' : 'rgba(255,255,255,0.02)',
                    borderColor: tf === false ? 'var(--color-again)' : 'var(--border-color)',
                    color: tf === false ? 'var(--color-again)' : 'var(--text-primary)',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                  }}
                >
                  Nein / Falsch (False)
                </button>
              </div>

              {reveal && (
                <>
                  <div className="card-answer-separator" />

                  {/* Correction feedback */}
                  <div style={{
                    padding: '12px 16px',
                    borderRadius: '12px',
                    background: tf === card.answer ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)',
                    color: tf === card.answer ? 'var(--color-good)' : 'var(--color-again)',
                    border: `1px solid ${tf === card.answer ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)'}`,
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}>
                    {tf === card.answer ? <Check size={18} /> : <X size={18} />}
                    {tf === null
                      ? 'No answer selected'
                      : tf === card.answer
                      ? 'Correct selection!'
                      : 'Incorrect selection!'}
                  </div>

                  <div style={{ marginTop: '12px', fontSize: '0.95rem' }}>
                    <strong>Correct Answer: </strong>
                    <span style={{ color: card.answer ? 'var(--color-good)' : 'var(--color-again)', fontWeight: 'bold' }}>
                      {card.answer ? 'Ja / Wahr' : 'Nein / Falsch'}
                    </span>
                  </div>

                  {card.explanation && (
                    <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '8px', lineHeight: '1.5' }}>
                      {card.explanation}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* 4. CORRECTION CARD */}
          {card.type === 'correction' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', textAlign: 'left' }}>
              <div>
                <span style={{ fontSize: '0.78rem', color: 'var(--color-again)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '4px' }}>
                  False Statement:
                </span>
                <p className="card-question" style={{ color: 'var(--text-secondary)' }}>{card.false_statement}</p>
              </div>

              {reveal && (
                <>
                  <div className="card-answer-separator" />
                  <div>
                    <span style={{ fontSize: '0.78rem', color: 'var(--color-good)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '4px' }}>
                      Correction / Real facts:
                    </span>
                    <p className="card-answer" style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: '1.1rem', lineHeight: '1.5' }}>
                      {card.correction}
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* 5. CLUSTER CARD */}
          {card.type === 'cluster' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', textAlign: 'left' }}>
              <p className="card-question" style={{ marginBottom: '10px' }}>{card.stem}</p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {card.items.map((clItem, idx) => {
                  const isSelectedTrue = clusters[idx] === true;
                  const isSelectedFalse = clusters[idx] === false;
                  const isCorrect = clusters[idx] === clItem.answer;

                  return (
                    <div
                      key={idx}
                      style={{
                        padding: '12px 14px',
                        borderRadius: '12px',
                        background: 'rgba(255,255,255,0.02)',
                        border: `1px solid ${reveal
                          ? (isCorrect ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)')
                          : 'var(--border-color)'}`,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                        <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: 500, flex: 1, lineHeight: '1.4' }}>
                          <strong>{clItem.label})</strong> {clItem.statement}
                        </span>

                        {/* Check / Close status icons when revealed */}
                        {reveal && (
                          <span style={{ color: isCorrect ? 'var(--color-good)' : 'var(--color-again)', display: 'flex', gap: '2px', alignItems: 'center', fontSize: '0.78rem', fontWeight: 600 }}>
                            {isCorrect ? <Check size={14} /> : <X size={14} />}
                            {clItem.answer ? 'Ja' : 'Nein'}
                          </span>
                        )}
                      </div>

                      {/* Ja/Nein Switch for the item */}
                      <div style={{ display: 'flex', gap: '8px', alignSelf: 'flex-end' }}>
                        <button
                          disabled={reveal || opts.disabled}
                          onClick={() => opts.setClusterSelection(idx, true)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: '6px',
                            fontSize: '0.78rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                            border: '1px solid',
                            background: isSelectedTrue ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                            borderColor: isSelectedTrue ? 'var(--color-good)' : 'var(--border-color)',
                            color: isSelectedTrue ? 'var(--color-good)' : 'var(--text-muted)'
                          }}
                        >
                          Ja
                        </button>
                        <button
                          disabled={reveal || opts.disabled}
                          onClick={() => opts.setClusterSelection(idx, false)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: '6px',
                            fontSize: '0.78rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                            border: '1px solid',
                            background: isSelectedFalse ? 'rgba(244, 63, 94, 0.15)' : 'transparent',
                            borderColor: isSelectedFalse ? 'var(--color-again)' : 'var(--border-color)',
                            color: isSelectedFalse ? 'var(--color-again)' : 'var(--text-muted)'
                          }}
                        >
                          Nein
                        </button>
                      </div>

                      {reveal && clItem.explanation && (
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '6px', marginTop: '2px', lineHeight: '1.4' }}>
                          {clItem.explanation}
                        </div>
                      )}

                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>

        {/* Card Footer — only the reveal action lives inside the card now. Rating happens in the
            persistent bottom control bar, so the answer content stays clear of the controls. */}
        <div>
          {!reveal && (
            <button className="btn btn-primary" disabled={opts.disabled} onClick={opts.onReveal} style={{ width: '100%', padding: '14px' }}>
              <Eye size={18} /> Show Answer
            </button>
          )}
        </div>
      </>
    );
  };

  // Counters over the append-only visit history: `ratedCount` visits are locked, the rest still
  // need a rating (skipped/deferred cards + any pending learning re-drills). Progress is rated /
  // total visits so appending a re-drill nudges the bar back — you genuinely have more to do.
  const ratedCount = Object.keys(answers).length;
  const remainingCount = queue.length - ratedCount;
  const progressPercent = queue.length > 0 ? Math.round((ratedCount / queue.length) * 100) : 100;

  // Size the card to fit exactly between where it starts and the top of the fixed control bar, so
  // the two can never overlap. Both ends are *measured*: `cardWrapperTop` is the card's real
  // viewport position (absorbing the header, the flex gap, and any safe-area top padding above it),
  // and `footerHeight` already includes the bar's own safe-area bottom padding. CARD_BOTTOM_GAP
  // covers the wrapper's bottom margin plus a little clearance. Deriving this from measurements
  // rather than hardcoded offsets is what keeps it correct under viewport-fit=cover, where the
  // insets are non-zero and would otherwise be missed (top) or double-counted (bottom).
  const CARD_BOTTOM_GAP = 24;
  const cardMaxHeightPx = Math.max(
    200,
    viewportHeight - cardWrapperTop - footerHeight - CARD_BOTTOM_GAP,
  );
  const cardMaxHeight = `${cardMaxHeightPx}px`;
  const cardSizing: React.CSSProperties = {
    maxHeight: cardMaxHeight,
    minHeight: `min(380px, ${cardMaxHeight})`,
  };
  // Animate the card's own height to its measured content height so growth (e.g. revealing the
  // answer) reads as a fluid downward extension, right up to the viewport clamp.
  const liveCardSizing: React.CSSProperties = {
    ...cardSizing,
    ...(cardContentHeight != null ? { height: `${Math.min(cardContentHeight, cardMaxHeightPx)}px` } : {}),
  };

  // Interval previews for the current card's rating buttons (from its pre-review progress).
  const currentPreviews = currentItem ? getNextReviewPreviews(currentItem.progress, customFSRSSettings) : null;

  // An interactive card (true/false, cluster) that has been *answered* incorrectly forces "Again":
  // the spec is "auto-selects Again for poor answers, and you can't change an auto-set Again". This
  // no longer depends on revealing the answer. An *unanswered* interactive card is NOT forced —
  // the user is then self-grading (rating stands as pressed), same as a basic card.
  let forcedAgain = false;
  if (currentItem && !isLocked) {
    const c = currentItem.card;
    if (c.type === 'truefalse') {
      forcedAgain = tfSelection !== null && tfSelection !== c.answer;
    } else if (c.type === 'cluster') {
      const fullyAnswered = c.items.every((_, idx) => clusterSelections[idx] !== undefined);
      forcedAgain = fullyAnswered && c.items.some((it, idx) => clusterSelections[idx] !== it.answer);
    }
  }

  // The highlighted rating: a locked visit shows its recorded choice; an unrated forced-Again card
  // shows Again pre-selected.
  const selectedRating = recorded?.rating ?? (forcedAgain ? Rating.Again : null);
  // Rating buttons are actionable as long as the visit isn't already locked and no flick is
  // mid-flight — the answer no longer has to be revealed first.
  const canRate = !!currentItem && !isLocked && !flicking;

  // Static per-rating presentation (colour + label), indexed by Rating enum value.
  const RATING_META: { rating: Rating; label: string; color: string; border: string }[] = [
    { rating: Rating.Again, label: 'Again', color: 'var(--color-again)', border: 'rgba(244, 63, 94, 0.3)' },
    { rating: Rating.Hard, label: 'Hard', color: 'var(--color-hard)', border: 'rgba(245, 158, 11, 0.3)' },
    { rating: Rating.Good, label: 'Good', color: 'var(--color-good)', border: 'rgba(16, 185, 129, 0.3)' },
    { rating: Rating.Easy, label: 'Easy', color: 'var(--color-easy)', border: 'rgba(59, 130, 246, 0.3)' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Sticky Session Progress Header */}
      <div
        ref={headerRef}
        className="session-sticky-header"
        style={{
          background: 'var(--bg-app)',
          // Carry the notch inset here rather than on the container: this element's own background
          // then covers the notch strip, including while it's pinned (sticky top: 0). `max()` keeps
          // the gap tight — the inset absorbs the 12px base instead of stacking on it.
          paddingTop: 'max(12px, env(safe-area-inset-top, 0px))',
          paddingBottom: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button
            onClick={onClose}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.9rem', padding: '4px 0' }}
          >
            <X size={16} /> Exit Session
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {studyAhead && (
              <span
                title="Reviewing cards ahead of their scheduled date can make FSRS's difficulty estimates less accurate."
                style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.78rem', color: 'var(--color-secondary)', fontWeight: 600, background: 'rgba(6, 182, 212, 0.1)', border: '1px solid rgba(6, 182, 212, 0.3)', borderRadius: '99px', padding: '2px 10px' }}
              >
                <Clock size={12} /> Studying Ahead
              </span>
            )}
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 600 }}>
              Remaining: {remainingCount}
            </span>
            <span style={{ fontSize: '0.85rem', color: 'var(--color-good)', fontWeight: 600 }}>
              Completed: {completedCount}
            </span>
          </div>
        </div>

        {/* Progress Bar */}
        <div style={{ width: '100%', height: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '99px', overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              width: `${progressPercent}%`,
              background: 'linear-gradient(90deg, var(--color-primary), var(--color-secondary))',
              borderRadius: '99px',
              transition: 'width 0.3s ease'
            }}
          />
        </div>
      </div>

      {/* Flashcard container (stacks the flicking card over the next one being revealed) */}
      <div ref={cardWrapperRef} className="card-wrapper">
        {currentItem && (
          <div
            ref={baseCardRef}
            className={`flashcard-3d ${showAnswer ? 'showing-answer' : 'studying'} ${skipHeightAnim ? 'no-height-anim' : ''}`}
            style={liveCardSizing}
          >
            <div ref={cardContentRef} className="flashcard-3d-content">
              {renderCardFace(currentItem, {
                showAnswer,
                tfSelection,
                clusterSelections,
                setTfSelection,
                setClusterSelection,
                onReveal: handleReveal,
                disabled: flicking !== null || isLocked,
              })}
            </div>
          </div>
        )}

        {/* Completion flick overlay — the just-rated card flicked off the deck */}
        {flicking && (
          <div className="card-flick-layer" style={{ ['--flick-color' as string]: flicking.color } as React.CSSProperties}>
            <div
              className={`flashcard-3d showing-answer card-flicking${flicking.graduated ? ' card-flicking-right' : ''}`}
              style={{ ...cardSizing, height: flicking.height != null ? `${flicking.height}px` : undefined }}
            >
              <div className="flashcard-3d-content">
                {renderCardFace(flicking.item, {
                  showAnswer: true,
                  tfSelection: flicking.tfSelection,
                  clusterSelections: flicking.clusterSelections,
                  setTfSelection: () => {},
                  setClusterSelection: () => {},
                  onReveal: () => {},
                  disabled: true,
                })}
              </div>
            </div>
          </div>
        )}

        {/* Reverse-flick overlay — on Undo the card flies back in from the side it left toward */}
        {flickingBack && (
          <div className="card-flick-layer" style={{ ['--flick-color' as string]: flickingBack.color } as React.CSSProperties}>
            <div
              className={`flashcard-3d showing-answer card-flicking-back${flickingBack.graduated ? ' card-flicking-back-right' : ''}`}
              style={{ ...cardSizing, height: flickingBack.height != null ? `${flickingBack.height}px` : undefined }}
            >
              <div className="flashcard-3d-content">
                {renderCardFace(flickingBack.item, {
                  showAnswer: true,
                  tfSelection: flickingBack.tfSelection,
                  clusterSelections: flickingBack.clusterSelections,
                  setTfSelection: () => {},
                  setClusterSelection: () => {},
                  onReveal: () => {},
                  disabled: true,
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Persistent bottom control bar — always-visible recall ratings above a Back/Forward row.
          Fixed to the viewport bottom so it never scrolls with (or overlaps) the card. */}
      <div ref={footerRef} className="session-control-bar">
        {/* Rating hint / lock explanation */}
        <p className="session-rating-hint">
          {isLocked
            ? recorded?.autoAgain
              ? 'Auto-rated “Again” for an incorrect answer — this rating is locked.'
              : 'Already rated — ratings are final within a session.'
            : forcedAgain
            ? 'Incorrect answer — this rates as “Again”.'
            : 'Rate your recall difficulty to schedule the next review:'}
        </p>

        {/* Four always-visible rating buttons */}
        <div className="session-rating-grid">
          {RATING_META.map(({ rating, label, color, border }) => {
            const isSelected = selectedRating === rating;
            // A forced-Again card locks the other three ratings out even before commit; a locked
            // visit dims every rating except the recorded one. Otherwise all four are actionable.
            const blocked = forcedAgain && rating !== Rating.Again;
            const clickable = canRate && !blocked;
            const dimmed = (isLocked && !isSelected) || blocked;
            return (
              <button
                key={rating}
                type="button"
                disabled={!clickable}
                aria-pressed={isSelected}
                onClick={() => clickable && handleRate(rating)}
                className={`session-rating-btn btn${isSelected ? ' is-selected' : ''}`}
                style={{
                  flexDirection: 'column',
                  background: isSelected ? color : 'var(--bg-surface)',
                  borderColor: isSelected ? color : border,
                  color: isSelected ? '#fff' : color,
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  padding: '8px 4px',
                  opacity: dimmed ? 0.4 : 1,
                  cursor: clickable ? 'pointer' : 'default',
                }}
              >
                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    color: isSelected ? 'rgba(255,255,255,0.85)' : 'var(--text-muted)',
                  }}
                >
                  {currentPreviews ? currentPreviews[rating].interval : ''}
                </span>
                <span style={{ fontSize: '0.88rem', fontWeight: 'bold' }}>{label}</span>
              </button>
            );
          })}
        </div>

        {/* Back / Forward navigation row. While an undo offer is open the Back slot becomes a timed
            Undo button that reverts the most recent rating. */}
        <div className="session-nav-row">
          {undoVisitId ? (
            <button
              type="button"
              className="btn btn-secondary session-nav-btn session-undo-btn"
              onClick={handleUndo}
            >
              <RotateCcw size={16} /> Undo{undoSecondsLeft > 0 ? ` (${undoSecondsLeft})` : ''}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary session-nav-btn"
              onClick={goBack}
              disabled={currentIdx === 0 || !!flicking}
            >
              <ChevronLeft size={18} /> Back
            </button>
          )}
          <span className="session-nav-pos">{queue.length > 0 ? currentIdx + 1 : 0} / {queue.length}</span>
          <button
            type="button"
            className="btn btn-secondary session-nav-btn"
            onClick={goForward}
            disabled={currentIdx >= queue.length - 1 || !!flicking}
          >
            Forward <ChevronRight size={18} />
          </button>
        </div>
      </div>

    </div>
  );
};
