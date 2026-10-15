import React, { useState, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, importDeckJson, exportDeckJson } from '../db';
import { Folder, FolderPlus, ChevronDown, ChevronRight, Pencil, Trash2, Upload, BookOpen, Layers, CheckCircle2, AlertCircle, Share2, Download, FileText } from 'lucide-react';
import type { Deck, Folder as DeckFolder } from '../types';
import { Modal } from './Modal';
import { isDeckActive } from '../hooks/useActiveDeckIds';
import { validateDeckFile } from '../deckValidator';

const Switch: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string }> = ({ checked, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    title={label}
    className={`switch ${checked ? 'on' : ''}`}
    onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
  >
    <span className="switch-thumb" />
  </button>
);

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
  const folders = useLiveQuery(() => db.folders.toArray());

  // Folder create/rename modal (`null` = closed) and delete confirmation.
  const [folderModal, setFolderModal] = useState<{ id?: string } | null>(null);
  const [folderName, setFolderName] = useState('');
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);

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

        const { errors } = validateDeckFile(parsed);
        if (errors.length > 0) {
          const shown = errors.slice(0, 6).map(e => `• ${e}`).join('\n');
          const more = errors.length > 6 ? `\n…and ${errors.length - 6} more` : '';
          throw new Error(`\n${shown}${more}`);
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

  const downloadTextFile = (filename: string, text: string, mimeType: string) => {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Loaded on demand: the guide embeds the validator source and is far larger than anything else
  // on this screen.
  const handleDownloadGuide = async () => {
    const { buildDeckGuide, DECK_GUIDE_FILENAME } = await import('../deckGuide');
    downloadTextFile(DECK_GUIDE_FILENAME, buildDeckGuide(), 'text/markdown');
  };

  const handleExportDeck = async (deckId: string, includeProgress: boolean) => {
    try {
      const jsonStr = await exportDeckJson(deckId, includeProgress);
      const suffix = includeProgress ? '_backup_with_progress' : '_shared';
      downloadTextFile(`deck_${deckId}${suffix}.json`, jsonStr, 'application/json');
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

  const sortedFolders = [...(folders ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
  const looseDecks = (decks ?? []).filter(d => !d.folderId || !folders?.some(f => f.id === d.folderId));

  const openFolderModal = (folder?: DeckFolder) => {
    setFolderName(folder?.name ?? '');
    setFolderModal({ id: folder?.id });
  };

  const handleSaveFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = folderName.trim();
    if (!name || !folderModal) return;
    if (folderModal.id) {
      await db.folders.update(folderModal.id, { name });
    } else {
      await db.folders.add({ id: 'folder_' + Math.random().toString(36).slice(2, 11), name, createdAt: Date.now() });
    }
    setFolderModal(null);
  };

  // Deleting a folder only un-files its decks; no cards or progress are touched.
  const handleDeleteFolder = async (folderId: string) => {
    await db.transaction('rw', [db.decks, db.folders], async () => {
      await db.decks.filter(d => d.folderId === folderId).modify(d => { delete d.folderId; });
      await db.folders.delete(folderId);
    });
    setDeletingFolderId(null);
  };

  const setDeckFolder = (deckId: string, folderId: string) =>
    db.decks.update(deckId, { folderId: folderId || undefined });

  const renderDeckCard = (deck: Deck, folder?: DeckFolder) => {
    const stats = getDeckStats(deck.id);
    const deckOn = deck.active !== false;
    const folderOff = folder?.active === false;
    const inProgramme = isDeckActive(deck, folders);
    return (
      <div key={deck.id} className="glass-panel deck-card">
        <div style={{ opacity: inProgramme ? 1 : 0.5, transition: 'opacity 0.2s ease' }}>
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

        <div className="deck-stats" style={{ opacity: inProgramme ? 1 : 0.5, transition: 'opacity 0.2s ease' }}>
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

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
          <Switch
            checked={deckOn}
            onChange={(checked) => db.decks.update(deck.id, { active: checked })}
            label={deckOn ? 'In study programme — click to pause this deck' : 'Paused — click to include in study programme'}
          />
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', flex: 1 }}>
            {folderOff ? 'Folder paused' : deckOn ? 'In study programme' : 'Paused'}
          </span>
          <select
            className="form-control"
            aria-label={`Folder for ${deck.titel}`}
            value={deck.folderId && folder ? deck.folderId : ''}
            onChange={(e) => setDeckFolder(deck.id, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'auto', maxWidth: '45%', padding: '6px 8px', fontSize: '0.75rem', borderRadius: '8px' }}
          >
            <option value="">No folder</option>
            {sortedFolders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
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
  };

  const renderFolder = (folder: DeckFolder) => {
    const folderDecks = (decks ?? []).filter(d => d.folderId === folder.id);
    const folderOn = folder.active !== false;
    const collapsed = folder.collapsed === true;
    const dueTotal = folderDecks.reduce((sum, d) => sum + getDeckStats(d.id).due, 0);
    return (
      <div key={folder.id} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div className="glass-panel" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            type="button"
            className="btn-icon"
            aria-label={collapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`}
            aria-expanded={!collapsed}
            onClick={() => db.folders.update(folder.id, { collapsed: !collapsed })}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0, background: 'none', border: 'none', padding: 0, textAlign: 'left', color: 'inherit', cursor: 'pointer', opacity: folderOn ? 1 : 0.55 }}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            <Folder size={16} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder.name}</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', flexShrink: 0 }}>
              {folderDecks.length} deck{folderDecks.length === 1 ? '' : 's'}
            </span>
            {folderOn && dueTotal > 0 && <span className="pill pill-due" style={{ flexShrink: 0 }}>{dueTotal} Due</span>}
            {!folderOn && <span className="pill pill-total" style={{ flexShrink: 0 }}>Paused</span>}
          </button>
          <button type="button" className="btn-icon" aria-label={`Rename ${folder.name}`} title="Rename folder" onClick={() => openFolderModal(folder)}>
            <Pencil size={14} />
          </button>
          <button type="button" className="btn-icon" aria-label={`Delete ${folder.name}`} title="Delete folder" onClick={() => setDeletingFolderId(folder.id)}>
            <Trash2 size={14} />
          </button>
          <Switch
            checked={folderOn}
            onChange={(checked) => db.folders.update(folder.id, { active: checked })}
            label={folderOn ? 'In study programme — click to pause all decks in this folder' : 'Paused — click to include this folder in study programme'}
          />
        </div>

        {!collapsed && (
          folderDecks.length === 0 ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', padding: '0 4px' }}>
              Empty folder — file decks here using the folder menu on a deck.
            </p>
          ) : (
            <div className="deck-grid">{folderDecks.map(d => renderDeckCard(d, folder))}</div>
          )
        )}
      </div>
    );
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '1.1rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Layers size={18} />
            Your Card Decks
          </h3>
          <button
            className="btn btn-secondary"
            onClick={() => openFolderModal()}
            style={{ padding: '8px 12px', fontSize: '0.85rem' }}
          >
            <FolderPlus size={14} />
            New Folder
          </button>
        </div>

        {(!decks || decks.length === 0) && sortedFolders.length === 0 ? (
          <div className="glass-panel" style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <Folder size={40} style={{ marginBottom: '12px', opacity: 0.5, color: 'var(--text-muted)' }} />
            <p style={{ fontSize: '0.95rem' }}>No card decks imported yet.</p>
            <p style={{ fontSize: '0.8rem', marginTop: '4px' }}>Upload a JSON deck file below to get started.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {sortedFolders.map(renderFolder)}

            {looseDecks.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {sortedFolders.length > 0 && (
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 4px' }}>
                    No folder
                  </span>
                )}
                <div className="deck-grid">{looseDecks.map(d => renderDeckCard(d))}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* JSON Import Section */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <h3 style={{ fontSize: '1.1rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Upload size={18} />
            Import or Add cards
          </h3>
          <button
            className="btn btn-secondary"
            onClick={handleDownloadGuide}
            style={{ padding: '8px 12px', fontSize: '0.85rem' }}
            title="Download instructions that teach an LLM to write a deck file for Kartomat, including a validator script"
          >
            <FileText size={14} />
            LLM Guide
          </button>
        </div>

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
            <span style={{ fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>{importStatus.message}</span>
          </div>
        )}
      </div>

      {/* Create / Rename Folder Modal */}
      {folderModal && (
        <Modal onClose={() => setFolderModal(null)} contentStyle={{ maxWidth: '420px' }}>
          <h3 style={{ fontSize: '1.25rem', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FolderPlus size={20} style={{ color: 'var(--color-primary)' }} />
            {folderModal.id ? 'Rename Folder' : 'New Folder'}
          </h3>
          <form onSubmit={handleSaveFolder}>
            <div className="form-group">
              <label className="form-label">Folder Name</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Philosophy 101"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '24px' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setFolderModal(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!folderName.trim()}>
                {folderModal.id ? 'Save' : 'Create'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Delete Folder Confirmation Modal */}
      {deletingFolderId !== null && (
        <Modal onClose={() => setDeletingFolderId(null)} contentStyle={{ maxWidth: '420px' }}>
          <h3 style={{ fontSize: '1.25rem', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-again)' }}>
            <Trash2 size={20} />
            Delete Folder
          </h3>
          <p style={{ fontSize: '0.92rem', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '24px' }}>
            Delete the folder <strong>{folders?.find(f => f.id === deletingFolderId)?.name}</strong>? Its decks are kept and move back to &ldquo;No folder&rdquo;. Cards and review progress are not affected.
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setDeletingFolderId(null)}>Cancel</button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => handleDeleteFolder(deletingFolderId)}
              style={{ background: 'var(--color-again)', borderColor: 'transparent', color: '#ffffff', boxShadow: '0 0 15px var(--color-again-glow)' }}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};
