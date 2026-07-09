import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { LearnHome } from './components/LearnHome';
import { DeckList } from './components/DeckList';
import { StudySession } from './components/StudySession';
import { SettingsModal } from './components/SettingsModal';
import { Settings, Sparkles, Layers, GraduationCap } from 'lucide-react';
import { deriveFSRSSettings } from './fsrs';
import type { FSRSSettings } from './types';
import { useRegisterSW } from 'virtual:pwa-register/react';

function App() {
  const [activeTab, setActiveTab] = useState<'learn' | 'decks'>('learn');
  const [isStudying, setIsStudying] = useState(false);
  const [sessionDeckIds, setSessionDeckIds] = useState<string[] | null>(null);
  const [customFSRSSettings, setCustomFSRSSettings] = useState<FSRSSettings | undefined>(undefined);
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // Initialize service worker update hooks
  const {
    needRefresh: [needRefresh],
    updateServiceWorker
  } = useRegisterSW();

  // Fetch data to display real-time global due counts in header
  const cards = useLiveQuery(() => db.cards.toArray());
  const progressList = useLiveQuery(() => db.progress.toArray());

  // Count total cards due in the database
  const getGlobalDueCount = () => {
    if (!cards || !progressList) return 0;
    const now = new Date();
    let due = 0;
    for (const card of cards) {
      const prog = progressList.find(p => p.cardId === card.id);
      if (prog && new Date(prog.due) <= now) {
        due++;
      }
    }
    return due;
  };

  const globalDueCount = getGlobalDueCount();

  const handleStartSession = async (deckIds: string[] | null, programmeId?: string) => {
    if (programmeId) {
      const prog = await db.programmes.get(programmeId);
      if (prog && prog.settings) {
        const derived = deriveFSRSSettings(prog.settings);
        setCustomFSRSSettings(derived);
      } else {
        setCustomFSRSSettings(undefined);
      }
    } else {
      setCustomFSRSSettings(undefined);
    }
    setSessionDeckIds(deckIds);
    setIsStudying(true);
  };

  return (
    <div className="app-container">
      
      {/* Premium Navigation Header */}
      <header className="app-header">
        <a href="/" className="app-logo" onClick={(e) => { e.preventDefault(); setIsStudying(false); }}>
          <img src="/icon.svg" alt="Kartomat Logo" />
          <h1>Kartomat</h1>
        </a>

        <div className="nav-actions">
          {/* Due Count Indicator */}
          {globalDueCount > 0 && !isStudying && (
            <div 
              className="pill pill-due" 
              style={{ 
                padding: '6px 12px', 
                fontSize: '0.8rem', 
                fontWeight: 700, 
                display: 'flex', 
                alignItems: 'center', 
                gap: '6px',
                cursor: 'pointer'
              }}
              onClick={() => handleStartSession(null)}
              title="Start Global Session"
            >
              <Sparkles size={12} fill="currentColor" />
              {globalDueCount} Due Today
            </div>
          )}

          {/* Settings Trigger */}
          <button 
            className="btn-icon" 
            onClick={() => setShowSettingsModal(true)}
            title="Tuning & Backups"
          >
            <Settings size={18} style={{ color: 'var(--text-secondary)' }} />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      {isStudying ? (
        <StudySession 
          deckIds={sessionDeckIds} 
          customFSRSSettings={customFSRSSettings}
          onClose={() => setIsStudying(false)} 
        />
      ) : (
        <>
          {/* Segmented Tab Switcher */}
          <div className="tab-switcher">
            <button 
              className={`tab-btn ${activeTab === 'learn' ? 'active' : ''}`}
              onClick={() => setActiveTab('learn')}
            >
              <GraduationCap size={18} />
              Learn
            </button>
            <button 
              className={`tab-btn ${activeTab === 'decks' ? 'active' : ''}`}
              onClick={() => setActiveTab('decks')}
            >
              <Layers size={18} />
              Decks
            </button>
          </div>

          {/* Tab Pages */}
          {activeTab === 'learn' ? (
            <LearnHome onStartSession={handleStartSession} />
          ) : (
            <DeckList />
          )}
        </>
      )}

      {/* Settings Modal */}
      {showSettingsModal && (
        <SettingsModal 
          needRefresh={needRefresh}
          updateServiceWorker={updateServiceWorker}
          onClose={() => setShowSettingsModal(false)} 
          onDatabaseReset={() => {
            // Triggered if database is restored, refresh states
            setShowSettingsModal(false);
          }}
        />
      )}

      {/* Floating PWA Update Banner */}
      {needRefresh && (
        <div style={{
          position: 'fixed',
          bottom: '24px',
          left: '24px',
          right: '24px',
          zIndex: 2000,
          padding: '16px 20px',
          background: 'var(--color-primary)',
          color: '#ffffff',
          borderRadius: '16px',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
          animation: 'slideUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
        }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            A new version of Kartomat is available!
          </span>
          <button 
            className="btn" 
            onClick={() => updateServiceWorker(true)}
            style={{ 
              background: '#ffffff', 
              color: 'var(--color-primary)', 
              padding: '8px 16px', 
              fontSize: '0.85rem',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer'
            }}
          >
            Update Now
          </button>
        </div>
      )}

    </div>
  );
}

export default App;
