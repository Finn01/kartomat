import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { Play, Plus, Trash2, Calendar, Layers, CheckCircle2, ChevronRight } from 'lucide-react';
import type { LearningProgramme } from '../types';

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
    if (!cards || !progressList) return { due: 0, newCards: 0, total: 0 };
    const filteredCards = cards.filter(c => deckIds.includes(c.deckId));
    
    let due = 0;
    let newCards = 0;
    const now = new Date();

    for (const card of filteredCards) {
      const prog = progressList.find(p => p.cardId === card.id);
      if (!prog) {
        newCards++;
      } else {
        const isDue = new Date(prog.due) <= now;
        if (isDue) due++;
      }
    }

    return { due, newCards, total: filteredCards.length };
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

  const handleDeleteProgramme = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to delete this learning programme?')) {
      await db.programmes.delete(id);
    }
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

      {/* Global Session Action */}
      <div className="glass-panel" style={{ padding: '28px', textAlign: 'center', background: 'linear-gradient(135deg, rgba(20, 21, 33, 0.7) 0%, rgba(139, 92, 246, 0.08) 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
        <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'var(--color-primary-glow)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary)' }}>
          <Play size={24} fill="currentColor" style={{ marginLeft: '4px' }} />
        </div>
        <div>
          <h2 style={{ fontSize: '1.35rem', marginBottom: '6px' }}>Start Global Learning Session</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', maxWidth: '500px', margin: '0 auto' }}>
            Study all due cards and introduce new cards from all decks in the database.
          </p>
        </div>
        
        {stats.total === 0 ? (
          <button className="btn btn-primary" disabled style={{ opacity: 0.5, cursor: 'not-allowed' }}>
            No cards available
          </button>
        ) : stats.due === 0 && stats.newCards === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <span style={{ fontSize: '0.9rem', color: 'var(--color-good)', display: 'inline-flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}>
              <CheckCircle2 size={16} /> All caught up for today!
            </span>
            <button className="btn btn-secondary" onClick={() => onStartSession(null)}>
              Review anyway (Custom Study)
            </button>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={() => onStartSession(null)}>
            Start Studying ({stats.due} Due + {Math.min(stats.newCards, 15)} New)
          </button>
        )}
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
                <div 
                  key={prog.id} 
                  className="glass-panel" 
                  onClick={() => progStats.total > 0 && onStartSession(prog.deckIds, prog.id)}
                  style={{ 
                    padding: '18px 20px', 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    cursor: progStats.total > 0 ? 'pointer' : 'default',
                    transition: 'all 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <h4 style={{ fontSize: '1.1rem', fontWeight: 600 }}>{prog.name}</h4>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Decks: {prog.deckIds.map(id => decks?.find(d => d.id === id)?.titel || id).join(', ')}
                    </p>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                      <span className="pill pill-total" style={{ fontSize: '0.7rem' }}>{progStats.total} Cards</span>
                      {progStats.due > 0 && (
                        <span className="pill pill-due" style={{ fontSize: '0.7rem' }}>{progStats.due} Due</span>
                      )}
                    </div>
                  </div>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    {progStats.total > 0 && (
                      <div className="btn btn-icon" style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.03)', border: 'none', color: 'var(--color-primary)' }}>
                        <ChevronRight size={18} />
                      </div>
                    )}
                    <button 
                      className="btn btn-icon" 
                      onClick={(e) => handleDeleteProgramme(prog.id, e)}
                      style={{ 
                        width: '36px', 
                        height: '36px', 
                        borderRadius: '8px', 
                        color: 'var(--text-muted)',
                        background: 'transparent',
                        border: 'none',
                      }}
                      title="Delete Programme"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create Programme Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
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
          </div>
        </div>
      )}

    </div>
  );
};
