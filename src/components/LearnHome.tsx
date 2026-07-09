import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { Play, Plus, Trash2, Calendar, Layers } from 'lucide-react';
import type { LearningProgramme } from '../types';
import { Modal } from './Modal';

interface ProgrammeItemProps {
  prog: LearningProgramme;
  decks: any[] | undefined;
  onStartSession: (deckIds: string[] | null, programmeId?: string) => void;
  onDelete: (id: string) => void;
  onDeleteComplete: (id: string) => void;
  progStats: {
    due: number;
    newCards: number;
    learning: number;
    total: number;
  };
  deletingProgId: string | null;
  confirmedDeletingId: string | null;
}

const ProgrammeItem: React.FC<ProgrammeItemProps> = ({ 
  prog, 
  decks, 
  onStartSession, 
  onDelete, 
  onDeleteComplete,
  progStats,
  deletingProgId,
  confirmedDeletingId
}) => {
  const [offsetX, setOffsetX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const textColRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [btnMarginTop, setBtnMarginTop] = useState(0);

  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const isSwipingRef = useRef(false);
  const offsetXRef = useRef(0);
  const wasDraggedRef = useRef(false);

  // Handle slide-back when user cancels in the modal
  useEffect(() => {
    if (deletingProgId !== prog.id && offsetXRef.current !== 0) {
      setOffsetX(0);
      offsetXRef.current = 0;
    }
  }, [deletingProgId, prog.id]);

  const BUTTON_SIZE = 36;

  // Push the play button as far down toward the pills row as it'll go
  // without wrapping anything, but never past the card's own vertical
  // center. Both the text column's height (title/deck-list line count,
  // pill count) and the card's overall height vary with content, so this
  // is measured rather than a fixed CSS offset.
  //
  // Both the text column and the button wrapper sit flush against the top
  // of the card's *content box* (alignSelf: flex-start on both), so all
  // measurements here are done relative to that content box, not the
  // card's padded border box that getBoundingClientRect() reports.
  useLayoutEffect(() => {
    const textEl = textColRef.current;
    const cardEl = cardRef.current;
    if (!textEl || !cardEl) return;

    const recompute = () => {
      const cardStyles = getComputedStyle(cardEl);
      const paddingTop = parseFloat(cardStyles.paddingTop) || 0;
      const paddingBottom = parseFloat(cardStyles.paddingBottom) || 0;
      const contentHeight = cardEl.getBoundingClientRect().height - paddingTop - paddingBottom;
      const textHeight = textEl.getBoundingClientRect().height;

      const maxCenter = contentHeight / 2;
      const desiredCenter = textHeight - BUTTON_SIZE / 2;
      const center = Math.min(desiredCenter, maxCenter);
      setBtnMarginTop(Math.max(0, center - BUTTON_SIZE / 2));
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(textEl);
    observer.observe(cardEl);
    return () => observer.disconnect();
  }, [prog.name, prog.deckIds, progStats.total, progStats.due, progStats.newCards, progStats.learning]);

  // Handle height-collapse exit animation when user confirms in the modal
  useEffect(() => {
    if (confirmedDeletingId === prog.id) {
      setIsDeleting(true);
      const timer = setTimeout(() => {
        onDeleteComplete(prog.id);
      }, 300); // matches the transition collapse duration
      return () => clearTimeout(timer);
    }
  }, [confirmedDeletingId, prog.id, onDeleteComplete]);

  useEffect(() => {
    const el = itemRef.current;
    if (!el) return;

    const beginGesture = (x: number, y: number) => {
      startXRef.current = x;
      startYRef.current = y;
      isSwipingRef.current = false;
      offsetXRef.current = 0;
    };

    const updateGesture = (x: number, y: number): boolean => {
      const diffX = x - startXRef.current;
      const diffY = y - startYRef.current;

      if (!isSwipingRef.current) {
        if (Math.abs(diffY) > Math.abs(diffX)) {
          return false; // Let vertical scroll happen
        }
        if (Math.abs(diffX) > 10) {
          isSwipingRef.current = true;
          setIsSwiping(true);
        }
      }

      if (isSwipingRef.current) {
        // Only allow swiping to the left (negative translation)
        const newOffset = diffX < 0 ? diffX : 0;
        offsetXRef.current = newOffset;
        setOffsetX(newOffset);
        return true;
      }
      return false;
    };

    const endGesture = () => {
      setIsSwiping(false);
      if (isSwipingRef.current) {
        isSwipingRef.current = false;
        wasDraggedRef.current = true;
        const threshold = -100;
        if (offsetXRef.current < threshold) {
          onDelete(prog.id);
        } else {
          setOffsetX(0);
          offsetXRef.current = 0;
        }
      }
    };

    // Mouse (unlike touch) fires a native `click` after mouseup even when
    // we called preventDefault/stopPropagation on the mousemove drag, so a
    // cancelled swipe-to-delete would otherwise still land as a click on
    // the card underneath and start a study session. Swallow exactly one
    // trailing click after a real drag.
    const handleClickCapture = (e: MouseEvent) => {
      if (wasDraggedRef.current) {
        wasDraggedRef.current = false;
        e.stopPropagation();
        e.preventDefault();
      }
    };

    // --- Touch (mobile) ---
    const handleTouchStart = (e: TouchEvent) => {
      beginGesture(e.touches[0].clientX, e.touches[0].clientY);
    };

    const handleTouchMove = (e: TouchEvent) => {
      const claimed = updateGesture(e.touches[0].clientX, e.touches[0].clientY);
      if (claimed) {
        // Stop page/tab scroll and prevent the outer tab-swipe handler
        // (which also listens for horizontal drags) from seeing this
        // gesture, so deleting an item can't also swipe the whole screen.
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (isSwipingRef.current) e.stopPropagation();
      endGesture();
    };

    // --- Mouse (desktop) ---
    const handleMouseDown = (e: MouseEvent) => {
      // Ignore non-primary buttons so right/middle click still works normally.
      if (e.button !== 0) return;
      beginGesture(e.clientX, e.clientY);
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    };

    const handleMouseMove = (e: MouseEvent) => {
      const claimed = updateGesture(e.clientX, e.clientY);
      if (claimed) e.stopPropagation();
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (isSwipingRef.current) e.stopPropagation();
      endGesture();
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });
    el.addEventListener('mousedown', handleMouseDown);
    el.addEventListener('click', handleClickCapture, { capture: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      el.removeEventListener('mousedown', handleMouseDown);
      el.removeEventListener('click', handleClickCapture, { capture: true });
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [onDelete, prog.id]);

  return (
    <div 
      ref={itemRef}
      style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: '20px',
        // Firefox can let a GPU-composited, translateX'd child (the
        // foreground card below) bleed a sliver past the rounded corners of
        // an `overflow: hidden` ancestor. clip-path clips composited layers
        // correctly there, so pair it with overflow:hidden as a belt-and-braces fix.
        clipPath: 'inset(0 round 20px)',
        maxHeight: isDeleting ? '0px' : '150px',
        opacity: isDeleting ? 0 : 1,
        marginBottom: isDeleting ? '0px' : '12px',
        transition: 'max-height 0.3s ease, opacity 0.3s ease, margin 0.3s ease',
      }}
    >
      {/* Background delete area */}
      <div
        onClick={() => onDelete(prog.id)}
        style={{
          position: 'absolute',
          // Inset 1px from the outer wrapper's own overflow:hidden/clipPath
          // bounds. Firefox's compositor doesn't always clip a translated,
          // separately-layered child (this sits behind the translateX'd
          // foreground card) flush with an ancestor's rounded overflow
          // clip — it can leave a 1px sliver of this div's own color
          // showing right at the boundary. Pulling the edge in by 1px means
          // that sliver, if it appears, is empty space instead of red.
          top: 1,
          left: 1,
          right: 1,
          bottom: 1,
          background: 'var(--color-again)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingRight: '24px',
          color: '#ffffff',
          borderRadius: '19px',
          cursor: 'pointer',
          zIndex: 1,
        }}
      >
        <Trash2 size={20} />
      </div>

      {/* Foreground card */}
      <div
        onClick={() => {
          if (offsetX === 0 && progStats.total > 0) {
            onStartSession(prog.deckIds, prog.id);
          }
        }}
        style={{
          transform: `translateX(${offsetX}px)`,
          transition: isSwiping ? 'none' : 'transform 0.2s ease',
          zIndex: 2,
          position: 'relative',
        }}
      >
        <div
          ref={cardRef}
          className="glass-panel"
          style={{
            padding: '18px 20px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: progStats.total > 0 ? 'pointer' : 'default',
            userSelect: 'none',
            background: 'var(--bg-surface)', // Opaque to cover red background
            // .glass-panel normally applies `backdrop-filter: blur(16px)`,
            // which samples pixels *behind* this element (including the
            // red delete background right underneath) before this opaque
            // background is painted on top. At the rounded corners, where
            // the element's own edge is anti-aliased to fractional
            // opacity, that blurred red bleeds through right at the seam.
            // This card needs to be a fully opaque cover, not glass, so
            // drop the blur entirely instead of trying to out-round it.
            backdropFilter: 'none',
            WebkitBackdropFilter: 'none',
          }}
        >
          <div ref={textColRef} style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0, alignSelf: 'flex-start' }}>
            <h4 style={{ fontSize: '1.1rem', fontWeight: 600 }}>{prog.name}</h4>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Decks: {prog.deckIds.map(id => decks?.find(d => d.id === id)?.titel || id).join(', ')}
            </p>
            <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
              <span className="pill pill-total" style={{ fontSize: '0.7rem' }}>{progStats.total} Cards</span>
              {progStats.due > 0 && (
                <span className="pill pill-due" style={{ fontSize: '0.7rem' }}>{progStats.due} Due</span>
              )}
              {progStats.newCards > 0 && (
                <span className="pill" style={{ fontSize: '0.7rem', background: 'rgba(6, 182, 212, 0.1)', color: 'var(--color-secondary)', border: '1px solid rgba(6, 182, 212, 0.3)' }}>{progStats.newCards} New</span>
              )}
              {progStats.learning > 0 && (
                <span className="pill" style={{ fontSize: '0.7rem', background: 'var(--color-primary-glow)', color: 'var(--color-primary)', border: '1px solid rgba(139, 92, 246, 0.3)' }}>{progStats.learning} Learning</span>
              )}
            </div>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', alignSelf: 'flex-start', marginTop: `${btnMarginTop}px`, transition: 'margin-top 0.2s ease' }}>
            {progStats.total > 0 && (
              <div
                style={{
                  width: `${BUTTON_SIZE}px`,
                  height: `${BUTTON_SIZE}px`,
                  borderRadius: '10px',
                  background: 'var(--color-primary)', 
                  color: '#ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px var(--color-primary-glow)'
                }}
              >
                <Play size={16} fill="currentColor" style={{ marginLeft: '2px' }} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

interface LearnHomeProps {
  onStartSession: (deckIds: string[] | null, programmeId?: string) => void;
}

export const LearnHome: React.FC<LearnHomeProps> = ({ onStartSession }) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newProgName, setNewProgName] = useState('');
  const [selectedDecks, setSelectedDecks] = useState<string[]>([]);
  const [targetRetention, setTargetRetention] = useState(0.90);
  const [hasDeadline, setHasDeadline] = useState(false);
  const [deadlineDate, setDeadlineDate] = useState('');

  // States for delete confirmation modal & countdown
  const [deletingProgId, setDeletingProgId] = useState<string | null>(null);
  const [confirmedDeletingId, setConfirmedDeletingId] = useState<string | null>(null);
  const [deleteDelayRemaining, setDeleteDelayRemaining] = useState(0);

  useEffect(() => {
    if (deletingProgId === null) return;
    
    setDeleteDelayRemaining(3);
    const interval = setInterval(() => {
      setDeleteDelayRemaining(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [deletingProgId]);

  const decks = useLiveQuery(() => db.decks.toArray());
  const cards = useLiveQuery(() => db.cards.toArray());
  const progressList = useLiveQuery(() => db.progress.toArray());
  const programmes = useLiveQuery(() => db.programmes.toArray());

  // Calculate Statistics
  const getStats = () => {
    if (!cards || !progressList) return { due: 0, newCards: 0, learning: 0, total: 0 };
    
    let due = 0;
    let newCards = 0;
    let learning = 0;
    const now = new Date();

    for (const card of cards) {
      const prog = progressList.find(p => p.cardId === card.id);
      if (!prog) {
        newCards++;
      } else {
        const isDue = new Date(prog.due) <= now;
        // ts-fsrs states: 0=New, 1=Learning, 2=Review, 3=Relearning
        if (prog.state === 1 || prog.state === 3) {
          learning++;
        }
        
        // If it is due, increment due count.
        // In FSRS, learning cards might also have a due date in the past, so they're counted.
        if (isDue) {
          due++;
        }
      }
    }

    return {
      due,
      newCards,
      learning,
      total: cards.length
    };
  };

  const stats = getStats();

  // Calculate stats for a specific set of decks (e.g. for a programme)
  const getDeckSetStats = (deckIds: string[]) => {
    if (!cards || !progressList) return { due: 0, newCards: 0, learning: 0, total: 0 };
    const filteredCards = cards.filter(c => deckIds.includes(c.deckId));
    
    let due = 0;
    let newCards = 0;
    let learning = 0;
    const now = new Date();

    for (const card of filteredCards) {
      const prog = progressList.find(p => p.cardId === card.id);
      if (!prog) {
        newCards++;
      } else {
        const isDue = new Date(prog.due) <= now;
        if (prog.state === 1 || prog.state === 3) {
          learning++;
        }
        if (isDue) due++;
      }
    }

    return { due, newCards, learning, total: filteredCards.length };
  };

  const handleCreateProgramme = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProgName.trim() || selectedDecks.length === 0) return;

    const newProg: LearningProgramme = {
      id: 'prog_' + Math.random().toString(36).substr(2, 9),
      name: newProgName.trim(),
      deckIds: selectedDecks,
      settings: {
        target_retention: targetRetention,
        has_deadline: hasDeadline,
        deadline_date: hasDeadline && deadlineDate ? deadlineDate : undefined
      },
      createdAt: Date.now()
    };

    await db.programmes.add(newProg);
    setNewProgName('');
    setSelectedDecks([]);
    setTargetRetention(0.90);
    setHasDeadline(false);
    setDeadlineDate('');
    setShowCreateModal(false);
  };

  const toggleDeckSelection = (deckId: string) => {
    if (selectedDecks.includes(deckId)) {
      setSelectedDecks(selectedDecks.filter(id => id !== deckId));
    } else {
      setSelectedDecks([...selectedDecks, deckId]);
    }
  };

  const handleDeleteRequest = (id: string) => {
    setDeletingProgId(id);
  };

  const handleDeleteComplete = async (id: string) => {
    await db.programmes.delete(id);
    setConfirmedDeletingId(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
      
      {/* Statistics Dashboard */}
      <div>
        <h3 style={{ fontSize: '1.1rem', color: 'var(--text-secondary)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Calendar size={18} />
          Study Summary
        </h3>
        
        <div className="stats-grid">
          {/* Due Today */}
          <div style={{ background: 'var(--color-again)', padding: '6px', borderRadius: '24px', boxShadow: '0 4px 12px rgba(244, 63, 94, 0.15)' }}>
            <div className="glass-panel stat-box" style={{ border: 'none', margin: 0, borderRadius: '18px', background: 'var(--bg-glass)', boxShadow: '0 8px 16px rgba(0, 0, 0, 0.55)', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div className="stat-value" style={{ color: 'var(--color-again)' }}>{stats.due}</div>
              <div className="stat-label">Due Today</div>
            </div>
          </div>

          {/* New Cards */}
          <div style={{ background: 'var(--color-secondary)', padding: '6px', borderRadius: '24px', boxShadow: '0 4px 12px rgba(6, 182, 212, 0.15)' }}>
            <div className="glass-panel stat-box" style={{ border: 'none', margin: 0, borderRadius: '18px', background: 'var(--bg-glass)', boxShadow: '0 8px 16px rgba(0, 0, 0, 0.55)', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div className="stat-value" style={{ color: 'var(--color-secondary)' }}>{stats.newCards}</div>
              <div className="stat-label">New Cards</div>
            </div>
          </div>

          {/* Learning */}
          <div style={{ background: 'var(--color-primary)', padding: '6px', borderRadius: '24px', boxShadow: '0 4px 12px rgba(139, 92, 246, 0.15)' }}>
            <div className="glass-panel stat-box" style={{ border: 'none', margin: 0, borderRadius: '18px', background: 'var(--bg-glass)', boxShadow: '0 8px 16px rgba(0, 0, 0, 0.55)', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div className="stat-value" style={{ color: 'var(--color-primary)' }}>{stats.learning}</div>
              <div className="stat-label">Learning</div>
            </div>
          </div>

          {/* Total Cards */}
          <div style={{ background: 'linear-gradient(135deg, #334155, #1e293b)', padding: '6px', borderRadius: '24px', boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)' }}>
            <div className="glass-panel stat-box" style={{ border: 'none', margin: 0, borderRadius: '18px', background: 'var(--bg-glass)', boxShadow: '0 8px 16px rgba(0, 0, 0, 0.55)', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div className="stat-value" style={{ color: 'var(--text-primary)' }}>{stats.total}</div>
              <div className="stat-label">Total Cards</div>
            </div>
          </div>
        </div>
      </div>

      {/* Minimal Global Study Action Panel */}
      <div style={{ display: 'flex', justifyContent: 'center', width: '100%', marginBottom: '8px' }}>
        <div 
          className="glass-panel" 
          style={{ 
            padding: '20px 24px', 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            gap: '14px',
            width: '100%',
            maxWidth: '380px',
            background: 'var(--bg-surface)',
            borderColor: 'var(--border-color)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {stats.total === 0 ? (
            <button className="btn btn-primary" disabled style={{ opacity: 0.5, cursor: 'not-allowed', width: '100%' }}>
              <Play size={16} fill="currentColor" />
              Start Studying
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => onStartSession(null)} style={{ width: '100%' }}>
              <Play size={16} fill="currentColor" />
              Start Studying
            </button>
          )}
          <div style={{ display: 'flex', gap: '10px' }}>
            <span className="pill pill-due" style={{ fontSize: '0.8rem', padding: '4px 12px' }}>{stats.due} Due</span>
            <span className="pill" style={{ fontSize: '0.8rem', padding: '4px 12px', background: 'rgba(6, 182, 212, 0.1)', color: 'var(--color-secondary)', border: '1px solid rgba(6, 182, 212, 0.3)' }}>
              {stats.newCards} New
            </span>
          </div>
        </div>
      </div>

      {/* Learning Programmes Section */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '1.1rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Layers size={18} />
            Learning Programmes
          </h3>
          
          <button 
            className="btn btn-secondary" 
            onClick={() => setShowCreateModal(true)}
            style={{ padding: '8px 12px', fontSize: '0.85rem' }}
            disabled={!decks || decks.length === 0}
          >
            <Plus size={14} />
            New Programme
          </button>
        </div>

        {!programmes || programmes.length === 0 ? (
          <div className="glass-panel" style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <p style={{ fontSize: '0.9rem' }}>No custom learning programmes yet.</p>
            <p style={{ fontSize: '0.78rem', marginTop: '4px' }}>Create one to group specific decks together for focused study sessions.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {programmes.map(prog => {
              const progStats = getDeckSetStats(prog.deckIds);
              return (
                <ProgrammeItem 
                  key={prog.id}
                  prog={prog}
                  decks={decks}
                  onStartSession={onStartSession}
                  onDelete={handleDeleteRequest}
                  onDeleteComplete={handleDeleteComplete}
                  progStats={progStats}
                  deletingProgId={deletingProgId}
                  confirmedDeletingId={confirmedDeletingId}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Create Programme Modal */}
      {showCreateModal && (
        <Modal onClose={() => setShowCreateModal(false)}>
            <h3 style={{ fontSize: '1.25rem', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Layers size={20} style={{ color: 'var(--color-primary)' }} />
              Create Learning Programme
            </h3>
            
            <form onSubmit={handleCreateProgramme}>
              <div className="form-group">
                <label className="form-label">Programme Name</label>
                <input 
                  type="text" 
                  className="form-control" 
                  placeholder="e.g. Midterm Preparation" 
                  value={newProgName}
                  onChange={(e) => setNewProgName(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" style={{ marginBottom: '10px' }}>Select Decks to Include</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto', paddingRight: '4px' }}>
                  {decks?.map(deck => (
                    <label 
                      key={deck.id}
                      style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '10px', 
                        padding: '10px 12px',
                        background: selectedDecks.includes(deck.id) ? 'rgba(139, 92, 246, 0.05)' : 'rgba(255,255,255,0.01)',
                        border: `1px solid ${selectedDecks.includes(deck.id) ? 'rgba(139, 92, 246, 0.3)' : 'var(--border-color)'}`,
                        borderRadius: '10px',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                        fontSize: '0.9rem'
                      }}
                    >
                      <input 
                        type="checkbox" 
                        checked={selectedDecks.includes(deck.id)}
                        onChange={() => toggleDeckSelection(deck.id)}
                        style={{ accentColor: 'var(--color-primary)', width: '16px', height: '16px' }}
                      />
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontWeight: 500 }}>{deck.titel}</span>
                        {deck.meta?.kurs && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{deck.meta.kurs}</span>}
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '20px 0' }} />

              <div className="form-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <label className="form-label" style={{ marginBottom: 0 }}>Target Correct Recall Ratio</label>
                  <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: 'var(--color-secondary)' }}>
                    {Math.round(targetRetention * 100)}%
                  </span>
                </div>
                <input 
                  type="range" 
                  min="0.70" 
                  max="0.99" 
                  step="0.01" 
                  value={targetRetention} 
                  onChange={(e) => setTargetRetention(parseFloat(e.target.value))} 
                  style={{ width: '100%', accentColor: 'var(--color-secondary)', cursor: 'pointer', height: '6px', borderRadius: '4px' }}
                />
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  The target success rate. Higher values schedule reviews closer together.
                </span>
              </div>

              <div className="form-group" style={{ background: 'rgba(255,255,255,0.01)', padding: '12px', border: '1px solid var(--border-color)', borderRadius: '10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 600 }}>
                  <input 
                    type="checkbox" 
                    checked={hasDeadline} 
                    onChange={(e) => setHasDeadline(e.target.checked)} 
                    style={{ accentColor: 'var(--color-primary)', width: '16px', height: '16px' }}
                  />
                  Study towards a deadline / exam date?
                </label>
                
                {hasDeadline && (
                  <div style={{ marginTop: '12px' }}>
                    <label className="form-label">Deadline Date</label>
                    <input 
                      type="date" 
                      className="form-control"
                      value={deadlineDate}
                      min={new Date(Date.now() + 86400000).toISOString().split('T')[0]} // Min is tomorrow
                      onChange={(e) => setDeadlineDate(e.target.value)}
                      required={hasDeadline}
                    />
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px', display: 'block', lineHeight: '1.4' }}>
                      FSRS will compress your scheduling intervals so that every card in this programme is reviewed at least once before this date.
                    </span>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '24px' }}>
                <button 
                  type="button" 
                  className="btn btn-secondary" 
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="btn btn-primary"
                  disabled={!newProgName.trim() || selectedDecks.length === 0}
                >
                  Create
                </button>
              </div>
            </form>
        </Modal>
      )}
      {/* Delete Confirmation Modal */}
      {deletingProgId !== null && (
        <Modal onClose={() => setDeletingProgId(null)} contentStyle={{ maxWidth: '420px' }}>
            <h3 style={{ fontSize: '1.25rem', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-again)' }}>
              <Trash2 size={20} />
              Delete Programme
            </h3>
            
            <p style={{ fontSize: '0.92rem', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '24px' }}>
              Are you sure you want to delete the learning programme <strong>{programmes?.find(p => p.id === deletingProgId)?.name}</strong>? This action only removes the group shortcut, your card decks and review progress will NOT be affected.
            </p>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button 
                type="button" 
                className="btn btn-secondary" 
                onClick={() => setDeletingProgId(null)}
              >
                Cancel
              </button>
              <button 
                type="button" 
                className="btn btn-primary"
                onClick={() => {
                  setConfirmedDeletingId(deletingProgId);
                  setDeletingProgId(null);
                }}
                disabled={deleteDelayRemaining > 0}
                style={{ 
                  background: deleteDelayRemaining > 0 ? 'rgba(255, 255, 255, 0.05)' : 'var(--color-again)',
                  borderColor: deleteDelayRemaining > 0 ? 'var(--border-color)' : 'transparent',
                  color: deleteDelayRemaining > 0 ? 'var(--text-muted)' : '#ffffff',
                  boxShadow: deleteDelayRemaining > 0 ? 'none' : '0 0 15px var(--color-again-glow)',
                  cursor: deleteDelayRemaining > 0 ? 'not-allowed' : 'pointer'
                }}
              >
                {deleteDelayRemaining > 0 ? `Delete (${deleteDelayRemaining}s)` : 'Delete'}
              </button>
            </div>
        </Modal>
      )}

    </div>
  );
};
