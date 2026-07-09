import { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';
import { LearnHome } from './components/LearnHome';
import { DeckList } from './components/DeckList';
import { StudySession } from './components/StudySession';
import { SettingsModal } from './components/SettingsModal';
import { Settings, Sparkles, Layers, GraduationCap, Check } from 'lucide-react';
import { deriveFSRSSettings } from './fsrs';
import type { FSRSSettings } from './types';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RubberBandContent } from './components/RubberBandContent';

function App() {
  const [activeTab, setActiveTab] = useState<'learn' | 'decks'>('learn');
  const [sessionDeckIds, setSessionDeckIds] = useState<string[] | null>(null);
  const [customFSRSSettings, setCustomFSRSSettings] = useState<FSRSSettings | undefined>(undefined);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [isUpdatingPWA, setIsUpdatingPWA] = useState(false);
  const [showUpdateSuccess, setShowUpdateSuccess] = useState(false);

  // Swipe tab states
  const [tabSwipeOffset, setTabSwipeOffset] = useState(0);
  const [isSwipingTabs, setIsSwipingTabs] = useState(false);
  const sliderContainerRef = useRef<HTMLDivElement>(null);

  const tabStartXRef = useRef(0);
  const tabStartYRef = useRef(0);
  const isSwipingTabsRef = useRef(false);
  const tabOffsetRef = useRef(0);

  // Study Session Entry/Exit State
  const [sessionState, setSessionState] = useState<'closed' | 'entering' | 'active' | 'exiting'>('closed');

  useEffect(() => {
    const el = sliderContainerRef.current;
    if (!el || sessionState !== 'closed') return;

    const handleTouchStart = (e: TouchEvent) => {
      tabStartXRef.current = e.touches[0].clientX;
      tabStartYRef.current = e.touches[0].clientY;
      isSwipingTabsRef.current = false;
      tabOffsetRef.current = 0;
    };

    const handleTouchMove = (e: TouchEvent) => {
      const diffX = e.touches[0].clientX - tabStartXRef.current;
      const diffY = e.touches[0].clientY - tabStartYRef.current;

      if (!isSwipingTabsRef.current) {
        if (Math.abs(diffY) > Math.abs(diffX)) {
          return; // Let vertical scroll happen
        }
        if (Math.abs(diffX) > 15) {
          isSwipingTabsRef.current = true;
          setIsSwipingTabs(true);
        }
      }

      if (isSwipingTabsRef.current) {
        if (e.cancelable) {
          e.preventDefault();
        }
        let newOffset = diffX;
        // Resistive bounds pull
        if (activeTab === 'learn' && diffX > 0) {
          newOffset = diffX * 0.2;
        } else if (activeTab === 'decks' && diffX < 0) {
          newOffset = diffX * 0.2;
        }
        tabOffsetRef.current = newOffset;
        setTabSwipeOffset(newOffset);
      }
    };

    const handleTouchEnd = () => {
      setIsSwipingTabs(false);
      if (isSwipingTabsRef.current) {
        isSwipingTabsRef.current = false;
        const threshold = window.innerWidth * 0.2;
        if (activeTab === 'learn' && tabOffsetRef.current < -threshold) {
          setActiveTab('decks');
        } else if (activeTab === 'decks' && tabOffsetRef.current > threshold) {
          setActiveTab('learn');
        }
        setTabSwipeOffset(0);
        tabOffsetRef.current = 0;
      }
    };

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [activeTab, sessionState]);

  // Check if we just installed an update
  useEffect(() => {
    const updated = localStorage.getItem('pwa_update_installed');
    if (updated === 'true') {
      localStorage.removeItem('pwa_update_installed');
      setShowUpdateSuccess(true);
      const timer = setTimeout(() => {
        setShowUpdateSuccess(false);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, []);

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
    setSessionState('entering');
    setTimeout(() => {
      setSessionState('active');
    }, 40);
  };

  const handleCloseSession = () => {
    setSessionState('exiting');
    setTimeout(() => {
      setSessionState('closed');
      setSessionDeckIds(null);
      setCustomFSRSSettings(undefined);
    }, 400); // matches the overlay slide transition duration
  };

  return (
    <div className="app-container">
      
      {/* Premium Navigation Header */}
      <header className="app-header">
        <a href="/" className="app-logo" onClick={(e) => { e.preventDefault(); handleCloseSession(); }}>
          <img src="/icon.svg" alt="Kartomat Logo" />
          <h1>Kartomat</h1>
        </a>

        <div className="nav-actions">
          {/* Due Count Indicator */}
          {globalDueCount > 0 && (
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
      <RubberBandContent disabled={sessionState !== 'closed'}>
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

        {/* Tab Pages with Slider Swipe Gestures */}
        <div ref={sliderContainerRef} className="tabs-slider-container">
          <div 
            className="tabs-slider-track"
            style={{
              transform: `translate3d(${(activeTab === 'learn' ? 0 : -50) + (tabSwipeOffset / (window.innerWidth || 375)) * 50}%, 0, 0)`,
              transition: isSwipingTabs ? 'none' : 'transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <div className="tab-page-wrapper">
              <LearnHome onStartSession={handleStartSession} />
            </div>
            <div className="tab-page-wrapper">
              <DeckList />
            </div>
          </div>
        </div>
      </RubberBandContent>

      {/* Fixed Overlay Study Session */}
      {sessionState !== 'closed' && (
        <div className={`study-session-overlay ${sessionState}`}>
          <div className="app-container" style={{ minHeight: 'auto', paddingTop: '12px', paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))' }}>
            <StudySession 
              deckIds={sessionDeckIds} 
              customFSRSSettings={customFSRSSettings}
              onClose={handleCloseSession} 
            />
          </div>
        </div>
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
            disabled={isUpdatingPWA}
            onClick={() => {
              setIsUpdatingPWA(true);
              localStorage.setItem('pwa_update_installed', 'true');
              // Briefly wait for spinner animation to play before service worker reloads
              setTimeout(() => {
                updateServiceWorker(true);
              }, 600);
            }}
            style={{ 
              background: '#ffffff', 
              color: 'var(--color-primary)', 
              padding: '8px 16px', 
              fontSize: '0.85rem',
              border: 'none',
              borderRadius: '8px',
              cursor: isUpdatingPWA ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
          >
            {isUpdatingPWA ? (
              <>
                <div className="spinner" />
                Updating...
              </>
            ) : (
              'Update Now'
            )}
          </button>
        </div>
      )}

      {/* Floating PWA Success Banner */}
      {showUpdateSuccess && (
        <div style={{
          position: 'fixed',
          bottom: '24px',
          left: '24px',
          right: '24px',
          zIndex: 2000,
          padding: '16px 20px',
          background: 'linear-gradient(135deg, var(--color-good), #065f46)',
          color: '#ffffff',
          borderRadius: '16px',
          boxShadow: '0 8px 32px var(--color-good-glow)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          animation: 'slideUpAndPulse 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)'
        }}>
          <div className="checkmark-circle">
            <Check size={18} strokeWidth={3} className="checkmark-icon" />
          </div>
          <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Kartomat has been successfully updated to the latest version!
          </span>
        </div>
      )}

    </div>
  );
}

export default App;
