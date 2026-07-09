import React, { useState, useEffect } from 'react';
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

  // Query database in raw format (we'll process this once on mount/deck change)
  const allCards = useLiveQuery(() => db.cards.toArray());
  const allProgress = useLiveQuery(() => db.progress.toArray());

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

  // Handle empty queue
  if (queue.length === 0) {
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

  const currentItem = queue[currentIdx];
  const { card, progress } = currentItem;

  // Calculate rating previews
  const previews = getNextReviewPreviews(progress, customFSRSSettings);

  // Determine if the current card was answered incorrectly (only for interactive types)
  const isInteractive = card.type === 'truefalse' || card.type === 'cluster';
  let isAnsweredIncorrectly = false;
  if (card.type === 'truefalse') {
    isAnsweredIncorrectly = tfSelection !== card.answer;
  } else if (card.type === 'cluster') {
    isAnsweredIncorrectly = card.items.some((item, idx) => clusterSelections[idx] !== item.answer);
  }

  const handleReveal = () => {
    setShowAnswer(true);
  };

  const handleRate = async (rating: Rating) => {
    // 1. Commit rating to IndexedDB
    const updatedProgress = await reviewCard(progress, rating, customFSRSSettings);
    setSessionReviewedCount(prev => prev + 1);

    // 2. Clear interactive card input states
    setTfSelection(null);
    setClusterSelections({});

    // 3. Spaced repetition queue re-handling:
    // Only if rated Again (Forgot/Failed) do we want to re-queue it in this session.
    // Otherwise (Hard/Good/Easy are passing grades), the card is completed and scheduled for the future.
    if (rating === Rating.Again) {
      // Put it back in the queue. Let's insert it 3-5 cards later to avoid showing it immediately, or at the end.
      const updatedQueue = [...queue];
      // Remove current item
      updatedQueue.splice(currentIdx, 1);
      
      const newQueueItem: SessionQueueItem = {
        card,
        progress: updatedProgress
      };

      // Insert at a distance, e.g. 3 cards down, or at the end
      const insertIdx = Math.min(updatedQueue.length, 3);
      updatedQueue.splice(insertIdx, 0, newQueueItem);
      
      setQueue(updatedQueue);
      // We don't advance the index because we removed current and inserted down,
      // so the next card is now at currentIdx automatically!
    } else {
      // Card is successfully scheduled in the future!
      setCompletedCount(prev => prev + 1);
      
      const updatedQueue = [...queue];
      updatedQueue.splice(currentIdx, 1);
      
      setQueue(updatedQueue);
      // Again, next card naturally slides into currentIdx, no need to increment!
    }

    setShowAnswer(false);
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

  const progressPercent = Math.round((completedCount / (completedCount + queue.length)) * 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      
      {/* Session Progress Header */}
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

      {/* Flashcard container */}
      <div className="card-wrapper">
        <div className={`flashcard-3d ${showAnswer ? 'showing-answer' : 'studying'}`}>
          
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
                {showAnswer && (
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
                  {renderClozeText(card.text, showAnswer)}
                </p>
                {showAnswer && card.extra && (
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
                    disabled={showAnswer}
                    onClick={() => setTfSelection(true)}
                    className="btn"
                    style={{ 
                      flex: 1, 
                      background: tfSelection === true ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255,255,255,0.02)',
                      borderColor: tfSelection === true ? 'var(--color-good)' : 'var(--border-color)',
                      color: tfSelection === true ? 'var(--color-good)' : 'var(--text-primary)',
                      borderStyle: 'solid',
                      borderWidth: '1px',
                    }}
                  >
                    Ja / Wahr (True)
                  </button>
                  <button 
                    disabled={showAnswer}
                    onClick={() => setTfSelection(false)}
                    className="btn"
                    style={{ 
                      flex: 1, 
                      background: tfSelection === false ? 'rgba(244, 63, 94, 0.15)' : 'rgba(255,255,255,0.02)',
                      borderColor: tfSelection === false ? 'var(--color-again)' : 'var(--border-color)',
                      color: tfSelection === false ? 'var(--color-again)' : 'var(--text-primary)',
                      borderStyle: 'solid',
                      borderWidth: '1px',
                    }}
                  >
                    Nein / Falsch (False)
                  </button>
                </div>

                {showAnswer && (
                  <>
                    <div className="card-answer-separator" />
                    
                    {/* Correction feedback */}
                    <div style={{ 
                      padding: '12px 16px', 
                      borderRadius: '12px', 
                      background: tfSelection === card.answer ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)',
                      color: tfSelection === card.answer ? 'var(--color-good)' : 'var(--color-again)',
                      border: `1px solid ${tfSelection === card.answer ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)'}`,
                      fontSize: '0.95rem',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px'
                    }}>
                      {tfSelection === card.answer ? <Check size={18} /> : <X size={18} />}
                      {tfSelection === null 
                        ? 'No answer selected' 
                        : tfSelection === card.answer 
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

                {showAnswer && (
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
                  {card.items.map((item, idx) => {
                    const isSelectedTrue = clusterSelections[idx] === true;
                    const isSelectedFalse = clusterSelections[idx] === false;
                    const isCorrect = clusterSelections[idx] === item.answer;

                    return (
                      <div 
                        key={idx}
                        style={{ 
                          padding: '12px 14px', 
                          borderRadius: '12px',
                          background: 'rgba(255,255,255,0.02)',
                          border: `1px solid ${showAnswer 
                            ? (isCorrect ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)') 
                            : 'var(--border-color)'}`,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '10px'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                          <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: 500, flex: 1, lineHeight: '1.4' }}>
                            <strong>{item.label})</strong> {item.statement}
                          </span>
                          
                          {/* Check / Close status icons when revealed */}
                          {showAnswer && (
                            <span style={{ color: isCorrect ? 'var(--color-good)' : 'var(--color-again)', display: 'flex', gap: '2px', alignItems: 'center', fontSize: '0.78rem', fontWeight: 600 }}>
                              {isCorrect ? <Check size={14} /> : <X size={14} />}
                              {item.answer ? 'Ja' : 'Nein'}
                            </span>
                          )}
                        </div>

                        {/* Ja/Nein Switch for the item */}
                        <div style={{ display: 'flex', gap: '8px', alignSelf: 'flex-end' }}>
                          <button
                            disabled={showAnswer}
                            onClick={() => setClusterSelections({ ...clusterSelections, [idx]: true })}
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
                            disabled={showAnswer}
                            onClick={() => setClusterSelections({ ...clusterSelections, [idx]: false })}
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

                        {showAnswer && item.explanation && (
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '6px', marginTop: '2px', lineHeight: '1.4' }}>
                            {item.explanation}
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
            {!showAnswer ? (
              <button className="btn btn-primary" onClick={handleReveal} style={{ width: '100%', padding: '14px' }}>
                <Eye size={18} /> Show Answer
              </button>
            ) : isInteractive && isAnsweredIncorrectly ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {/* Single big Again button */}
                <button 
                  onClick={() => handleRate(Rating.Again)}
                  className="btn btn-primary" 
                  style={{ 
                    width: '100%', 
                    padding: '14px',
                    background: 'linear-gradient(135deg, var(--color-again), #be123c)',
                    borderColor: 'var(--color-again)',
                    boxShadow: '0 4px 12px var(--color-again-glow)',
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
                    onClick={() => handleRate(Rating.Again)}
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
                    onClick={() => handleRate(Rating.Hard)}
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
                    onClick={() => handleRate(Rating.Good)}
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
                    onClick={() => handleRate(Rating.Easy)}
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

        </div>
      </div>

    </div>
  );
};
