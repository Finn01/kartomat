import React, { useState, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, importDeckJson, exportDeckJson } from '../db';
import { Folder, Upload, BookOpen, Layers, CheckCircle2, AlertCircle, Share2, Download } from 'lucide-react';

interface DeckListProps {
  onSelectDeck?: (deckId: string) => void; // Optional if we want deck drilling
}

export const DeckList: React.FC<DeckListProps> = () => {
  const [dragActive, setDragActive] = useState(false);
  const [importStatus, setImportStatus] = useState<{ type: 'idle' | 'success' | 'error'; message: string }>({ type: 'idle', message: '' });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const decks = useLiveQuery(() => db.decks.toArray());
  const cards = useLiveQuery(() => db.cards.toArray());
  const progressList = useLiveQuery(() => db.progress.toArray());

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const processFile = async (file: File) => {
    setImportStatus({ type: 'idle', message: '' });
    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const text = e.target?.result as string;
        const parsed = JSON.parse(text);
        
        if (!parsed.decks && !parsed.cards) {
          throw new Error("Missing deck data structure in JSON.");
        }
        
        await importDeckJson(parsed);
        setImportStatus({ type: 'success', message: `Imported successfully!` });
      } catch (err) {
        setImportStatus({ type: 'error', message: `Import failed: ${(err as Error).message}` });
      }
    };

    reader.readAsText(file);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      await processFile(e.dataTransfer.files[0]);
    }
  };

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      await processFile(e.target.files[0]);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const handleExportDeck = async (deckId: string, includeProgress: boolean) => {
    try {
      const jsonStr = await exportDeckJson(deckId, includeProgress);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const suffix = includeProgress ? '_backup_with_progress' : '_shared';
      a.download = `deck_${deckId}${suffix}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Export failed: ' + (err as Error).message);
    }
  };

  // Helper to compute deck stats
  const getDeckStats = (deckId: string) => {
    if (!cards || !progressList) return { total: 0, due: 0, newCards: 0 };
    const deckCards = cards.filter(c => c.deckId === deckId);
    
    let due = 0;
    let newCards = 0;
    const now = new Date();

    for (const card of deckCards) {
      const prog = progressList.find(p => p.cardId === card.id);
      if (!prog) {
        newCards++;
      } else {
        const isDue = new Date(prog.due) <= now;
        if (isDue) due++;
      }
    }

    return { total: deckCards.length, due, newCards };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
      {/* Introduction Banner - Hidden for now
      <div className="glass-panel" style={{ padding: '24px', display: 'flex', gap: '16px', alignItems: 'center', background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.08) 0%, rgba(6, 182, 212, 0.08) 100%)' }}>
        <div style={{ padding: '12px', borderRadius: '12px', background: 'rgba(139, 92, 246, 0.1)', color: 'var(--color-primary)' }}>
          <Sparkles size={24} />
        </div>
        <div>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '4px' }}>Welcome to Kartomat</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
            To study, select cards on the <strong>Learn</strong> page. Import card decks by uploading a JSON deck file below. Existing decks with the same ID will be merged, updating content while preserving your local learning progress!
          </p>
        </div>
      </div>
      */}

      {/* Decks Grid */}
      <div>
        <h3 style={{ fontSize: '1.1rem', color: 'var(--text-secondary)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Layers size={18} />
          Your Card Decks
        </h3>

        {!decks || decks.length === 0 ? (
          <div className="glass-panel" style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <Folder size={40} style={{ marginBottom: '12px', opacity: 0.5, color: 'var(--text-muted)' }} />
            <p style={{ fontSize: '0.95rem' }}>No card decks imported yet.</p>
            <p style={{ fontSize: '0.8rem', marginTop: '4px' }}>Upload a JSON deck file below to get started.</p>
          </div>
        ) : (
          <div className="deck-grid">
            {decks.map(deck => {
              const stats = getDeckStats(deck.id);
              return (
                <div key={deck.id} className="glass-panel deck-card">
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-secondary)', background: 'rgba(6, 182, 212, 0.08)', padding: '2px 8px', borderRadius: '4px' }}>
                        ID: {deck.id}
                      </span>
                    </div>
                    <h4 className="deck-title">{deck.titel}</h4>
                    {deck.meta?.kurs && (
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '6px' }}>
                        <BookOpen size={12} />
                        {deck.meta.kurs}
                      </p>
                    )}
                  </div>
                  
                  <div className="deck-stats">
                    <div className="pills-container">
                      {stats.due > 0 && (
                        <span className="pill pill-due">{stats.due} Due</span>
                      )}
                      {stats.newCards > 0 && (
                        <span className="pill" style={{ background: 'rgba(6, 182, 212, 0.1)', color: 'var(--color-secondary)', border: '1px solid rgba(6, 182, 212, 0.3)' }}>{stats.newCards} New</span>
                      )}
                    </div>
                    <span className="pill pill-total">{stats.total} Cards</span>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
                    <button 
                      className="btn btn-secondary" 
                      onClick={(e) => { e.stopPropagation(); handleExportDeck(deck.id, false); }}
                      style={{ flex: 1, padding: '6px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}
                      title="Export cards only (share with friends)"
                    >
                      <Share2 size={12} /> Share
                    </button>
                    <button 
                      className="btn btn-secondary" 
                      onClick={(e) => { e.stopPropagation(); handleExportDeck(deck.id, true); }}
                      style={{ flex: 1, padding: '6px 8px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}
                      title="Export cards + your FSRS study progress"
                    >
                      <Download size={12} /> Backup
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* JSON Import Section */}
      <div>
        <h3 style={{ fontSize: '1.1rem', color: 'var(--text-secondary)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Upload size={18} />
          Import or Add cards
        </h3>

        <div 
          className={`dropzone ${dragActive ? 'active' : ''}`}
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          onClick={triggerFileInput}
        >
          <Upload size={32} className="dropzone-icon" />
          <div>
            <p style={{ fontSize: '0.95rem', fontWeight: 600 }}>Drag and drop your JSON deck here</p>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>or click to browse local files</p>
          </div>
          <input 
            type="file"
            ref={fileInputRef}
            onChange={handleChange}
            accept=".json"
            style={{ display: 'none' }}
          />
        </div>

        {importStatus.type !== 'idle' && (
          <div className="glass-panel" style={{ 
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '16px', 
            marginTop: '16px',
            background: importStatus.type === 'success' ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)',
            borderColor: importStatus.type === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.2)',
            color: importStatus.type === 'success' ? 'var(--color-good)' : 'var(--color-again)'
          }}>
            {importStatus.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
            <span style={{ fontSize: '0.9rem' }}>{importStatus.message}</span>
          </div>
        )}
      </div>
    </div>
  );
};
