import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Flashcard, CardProgress, FSRSSettings } from '../types';
import { Rating } from 'ts-fsrs';
import { reviewCard, createNewProgress, getNextReviewPreviews } from '../fsrs';
import { X, Check, Eye, CheckCircle2 } from 'lucide-react';

interface StudySessionProps {
  deckIds: string[] | null; // null means global study (all decks)
  customFSRSSettings?: FSRSSettings;
  onClose: () => void;
}

interface SessionQueueItem {
  card: Flashcard;
  progress: CardProgress;
}

type RatingPreviews = ReturnType<typeof getNextReviewPreviews>;

// Snapshot of the card being flicked away so the animation is immune to queue changes underneath.
interface FlickSnapshot {
  item: SessionQueueItem;
  tfSelection: boolean | null;
  clusterSelections: Record<number, boolean>;
  previews: RatingPreviews;
  color: string;
  height: number | null;
}

// Options controlling how a single card face is rendered (shared by the live card and the flick overlay).
interface CardFaceOptions {
  showAnswer: boolean;
  tfSelection: boolean | null;
  clusterSelections: Record<number, boolean>;
  previews: RatingPreviews;
  setTfSelection: (value: boolean) => void;
  setClusterSelection: (idx: number, value: boolean) => void;
  onReveal: () => void;
  onRate: (rating: Rating) => void;
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
  const currentIdx = 0;
  const [showAnswer, setShowAnswer] = useState(false);
  const [completedCount, setCompletedCount] = useState(0);
  const [sessionReviewedCount, setSessionReviewedCount] = useState(0);

  // Card type specific states
  const [tfSelection, setTfSelection] = useState<boolean | null>(null);
  const [clusterSelections, setClusterSelections] = useState<Record<number, boolean>>({});

  // Completion animation state (the card currently being flicked off the deck)
  const [flicking, setFlicking] = useState<FlickSnapshot | null>(null);

  // Measure the sticky header so the card can be sized to fit the viewport beneath it.
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(72);

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

  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () => setHeaderHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

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
  }, [queue.length > 0 ? queue[currentIdx].card.id : null]);

  useEffect(() => {
    if (!allCards || !allProgress) return;

    const prepareQueue = async () => {
      // 1. Filter cards by selected decks
      const filteredCards = deckIds
        ? allCards.filter(c => deckIds.includes(c.deckId))
        : allCards;

      const now = new Date();
      const dueItems: SessionQueueItem[] = [];
      const newItems: SessionQueueItem[] = [];

      for (const card of filteredCards) {
        let prog = allProgress.find(p => p.cardId === card.id);

        if (!prog) {
          // It's a new card, create new progress but don't save to DB until reviewed
          prog = createNewProgress(card.id, card.deckId);
          newItems.push({ card, progress: prog });
        } else {
          const isDue = new Date(prog.due) <= now;
          if (isDue) {
            dueItems.push({ card, progress: prog });
          }
        }
      }

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

      setQueue([...dueLearning, ...dueReview, ...shuffledNew]);
      setLoading(false);
    };

    prepareQueue();
  }, [allCards, allProgress, deckIds]);

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

  // Handle empty queue — but let a final flick finish playing before showing the summary.
  if (queue.length === 0 && !flicking) {
    return (
      <div className="glass-panel" style={{ padding: '48px 24px', textAlign: 'center', margin: '40px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
        <div style={{ padding: '16px', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.1)', color: 'var(--color-good)' }}>
          <CheckCircle2 size={44} />
        </div>
        <div>
          <h2 style={{ fontSize: '1.4rem', marginBottom: '8px' }}>Session Complete!</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', maxWidth: '400px', margin: '0 auto', lineHeight: '1.4' }}>
            Excellent job! You reviewed {sessionReviewedCount} cards in this session. All cards have been scheduled for their next intervals.
          </p>
        </div>
        <button className="btn btn-primary" onClick={onClose}>
          Return to Dashboard
        </button>
      </div>
    );
  }

  const currentItem = queue.length > 0 ? queue[currentIdx] : null;

  const handleReveal = () => {
    setShowAnswer(true);
  };

  const handleRate = async (rating: Rating) => {
    // Ignore new ratings while a flick animation is in flight.
    if (flicking) return;

    const item = queue[currentIdx];
    if (!item) return;
    const { card, progress } = item;

    // Determine if an interactive card was answered incorrectly (drives the red flick border).
    const isInteractive = card.type === 'truefalse' || card.type === 'cluster';
    let incorrect = false;
    if (card.type === 'truefalse') {
      incorrect = tfSelection !== card.answer;
    } else if (card.type === 'cluster') {
      incorrect = card.items.some((clItem, idx) => clusterSelections[idx] !== clItem.answer);
    }
    const flickIncorrect = isInteractive && incorrect;

    // 1. Snapshot the outgoing card (including its current pixel height) so it keeps rendering
    //    at a stable size as it flicks away, independent of the next card revealed beneath it.
    setFlicking({
      item,
      tfSelection,
      clusterSelections,
      previews: getNextReviewPreviews(progress, customFSRSSettings),
      color: flickColor(rating, flickIncorrect),
      height: baseCardRef.current?.offsetHeight ?? null,
    });

    // 2. Commit rating to IndexedDB
    const updatedProgress = await reviewCard(progress, rating, customFSRSSettings);
    setSessionReviewedCount(prev => prev + 1);

    // 3. Reset interactive/reveal state for the next card (revealed beneath the flicking card)
    setTfSelection(null);
    setClusterSelections({});
    setShowAnswer(false);

    // 4. Spaced repetition queue re-handling:
    // Only if rated Again (Forgot/Failed) do we want to re-queue it in this session.
    // Otherwise (Hard/Good/Easy are passing grades), the card is completed and scheduled for the future.
    if (rating === Rating.Again) {
      // Put it back in the queue, a few cards later, to avoid showing it immediately.
      const updatedQueue = [...queue];
      updatedQueue.splice(currentIdx, 1);

      const newQueueItem: SessionQueueItem = {
        card,
        progress: updatedProgress
      };

      const insertIdx = Math.min(updatedQueue.length, 3);
      updatedQueue.splice(insertIdx, 0, newQueueItem);

      setQueue(updatedQueue);
    } else {
      // Card is successfully scheduled in the future!
      setCompletedCount(prev => prev + 1);

      const updatedQueue = [...queue];
      updatedQueue.splice(currentIdx, 1);

      setQueue(updatedQueue);
    }

    // 5. Clear the flick snapshot once the animation has played.
    setTimeout(() => setFlicking(null), FLICK_DURATION_MS);
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
    const { showAnswer: reveal, tfSelection: tf, clusterSelections: clusters, previews } = opts;

    const isInteractive = card.type === 'truefalse' || card.type === 'cluster';
    let isAnsweredIncorrectly = false;
    if (card.type === 'truefalse') {
      isAnsweredIncorrectly = tf !== card.answer;
    } else if (card.type === 'cluster') {
      isAnsweredIncorrectly = card.items.some((it, idx) => clusters[idx] !== it.answer);
    }

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
                  disabled={reveal}
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
                  disabled={reveal}
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
                          disabled={reveal}
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
                          disabled={reveal}
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

        {/* Card Footer (Action Controls) */}
        <div>
          {!reveal ? (
            <button className="btn btn-primary" disabled={opts.disabled} onClick={opts.onReveal} style={{ width: '100%', padding: '14px' }}>
              <Eye size={18} /> Show Answer
            </button>
          ) : isInteractive && isAnsweredIncorrectly ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Single big Again button */}
              <button
                disabled={opts.disabled}
                onClick={() => opts.onRate(Rating.Again)}
                className="btn btn-primary"
                style={{
                  width: '100%',
                  padding: '14px',
                  background: 'linear-gradient(135deg, var(--color-easy), #1d4ed8)',
                  borderColor: 'var(--color-easy)',
                  boxShadow: '0 4px 12px var(--color-easy-glow)',
                  color: '#ffffff',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  cursor: 'pointer'
                }}
              >
                <span style={{ fontSize: '0.95rem', fontWeight: 'bold' }}>Next Card</span>
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>

              {/* Rating Guide Prompt */}
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', marginBottom: '4px' }}>
                Rate your recall difficulty to schedule next review:
              </p>

              {/* Grid of four buttons */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>

                {/* Rating.Again */}
                <button
                  disabled={opts.disabled}
                  onClick={() => opts.onRate(Rating.Again)}
                  className="btn"
                  style={{
                    flexDirection: 'column',
                    background: 'var(--bg-surface)',
                    borderColor: 'rgba(244, 63, 94, 0.3)',
                    color: 'var(--color-again)',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    padding: '8px 4px'
                  }}
                >
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                    {previews[Rating.Again].interval}
                  </span>
                  <span style={{ fontSize: '0.88rem', fontWeight: 'bold' }}>Again</span>
                </button>

                {/* Rating.Hard */}
                <button
                  disabled={opts.disabled}
                  onClick={() => opts.onRate(Rating.Hard)}
                  className="btn"
                  style={{
                    flexDirection: 'column',
                    background: 'var(--bg-surface)',
                    borderColor: 'rgba(245, 158, 11, 0.3)',
                    color: 'var(--color-hard)',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    padding: '8px 4px'
                  }}
                >
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                    {previews[Rating.Hard].interval}
                  </span>
                  <span style={{ fontSize: '0.88rem', fontWeight: 'bold' }}>Hard</span>
                </button>

                {/* Rating.Good */}
                <button
                  disabled={opts.disabled}
                  onClick={() => opts.onRate(Rating.Good)}
                  className="btn"
                  style={{
                    flexDirection: 'column',
                    background: 'var(--bg-surface)',
                    borderColor: 'rgba(16, 185, 129, 0.3)',
                    color: 'var(--color-good)',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    padding: '8px 4px'
                  }}
                >
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                    {previews[Rating.Good].interval}
                  </span>
                  <span style={{ fontSize: '0.88rem', fontWeight: 'bold' }}>Good</span>
                </button>

                {/* Rating.Easy */}
                <button
                  disabled={opts.disabled}
                  onClick={() => opts.onRate(Rating.Easy)}
                  className="btn"
                  style={{
                    flexDirection: 'column',
                    background: 'var(--bg-surface)',
                    borderColor: 'rgba(59, 130, 246, 0.3)',
                    color: 'var(--color-easy)',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    padding: '8px 4px'
                  }}
                >
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                    {previews[Rating.Easy].interval}
                  </span>
                  <span style={{ fontSize: '0.88rem', fontWeight: 'bold' }}>Easy</span>
                </button>

              </div>
            </div>
          )}
        </div>
      </>
    );
  };

  const total = completedCount + queue.length;
  const progressPercent = total > 0 ? Math.round((completedCount / total) * 100) : 100;

  // Size the card to fit under the sticky header; once content exceeds this, the whole card scrolls.
  const cardMaxHeight = `calc(100dvh - ${headerHeight}px - 96px - env(safe-area-inset-bottom, 0px))`;
  const cardSizing: React.CSSProperties = {
    maxHeight: cardMaxHeight,
    minHeight: `min(380px, ${cardMaxHeight})`,
  };
  // Numeric twin of cardMaxHeight, used to clamp the animated height target below — animating
  // `height` toward a value beyond the CSS max-height would just be clipped instantly with no
  // visible transition, so we cap the JS target at the same limit.
  const cardMaxHeightPx = Math.max(200, viewportHeight - headerHeight - 96);
  // Animate the card's own height to its measured content height so growth (e.g. revealing the
  // answer) reads as a fluid downward extension, right up to the viewport clamp.
  const liveCardSizing: React.CSSProperties = {
    ...cardSizing,
    ...(cardContentHeight != null ? { height: `${Math.min(cardContentHeight, cardMaxHeightPx)}px` } : {}),
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Sticky Session Progress Header */}
      <div
        ref={headerRef}
        className="session-sticky-header"
        style={{
          background: 'var(--bg-app)',
          paddingTop: '12px',
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
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 600 }}>
              Remaining: {queue.length}
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
      <div className="card-wrapper">
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
                previews: getNextReviewPreviews(currentItem.progress, customFSRSSettings),
                setTfSelection: (value) => setTfSelection(value),
                setClusterSelection: (idx, value) => setClusterSelections(prev => ({ ...prev, [idx]: value })),
                onReveal: handleReveal,
                onRate: handleRate,
                disabled: false,
              })}
            </div>
          </div>
        )}

        {/* Completion flick overlay — the just-rated card flicked off the deck */}
        {flicking && (
          <div className="card-flick-layer" style={{ ['--flick-color' as string]: flicking.color } as React.CSSProperties}>
            <div
              className="flashcard-3d showing-answer card-flicking"
              style={{ ...cardSizing, height: flicking.height != null ? `${flicking.height}px` : undefined }}
            >
              <div className="flashcard-3d-content">
                {renderCardFace(flicking.item, {
                  showAnswer: true,
                  tfSelection: flicking.tfSelection,
                  clusterSelections: flicking.clusterSelections,
                  previews: flicking.previews,
                  setTfSelection: () => {},
                  setClusterSelection: () => {},
                  onReveal: () => {},
                  onRate: () => {},
                  disabled: true,
                })}
              </div>
            </div>
          </div>
        )}
      </div>

    </div>
  );
};
