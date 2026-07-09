import React, { useState, useEffect } from 'react';
import { getFSRSSettings, saveFSRSSettings } from '../fsrs';
import { exportBackupJson, restoreBackupJson } from '../db';
import { X, Download, Upload, Sliders, Database, Info, RefreshCw } from 'lucide-react';
import type { FSRSSettings } from '../types';

interface SettingsModalProps {
  needRefresh: boolean;
  updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
  onClose: () => void;
  onDatabaseReset?: () => void; // Triggered after restoring database to refresh parent states
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ needRefresh, updateServiceWorker, onClose, onDatabaseReset }) => {
  const [settings, setSettings] = useState<FSRSSettings>({ request_retention: 0.90, maximum_interval: 36500 });
  const [importStatus, setImportStatus] = useState<{ type: 'idle' | 'success' | 'error'; message: string }>({ type: 'idle', message: '' });
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');

  // Load settings on mount
  useEffect(() => {
    setSettings(getFSRSSettings());
  }, []);

  const handleRetentionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    const newSettings = { ...settings, request_retention: val };
    setSettings(newSettings);
    saveFSRSSettings(newSettings);
  };

  const handleMaxIntervalChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value) || 36500;
    const newSettings = { ...settings, maximum_interval: val };
    setSettings(newSettings);
    saveFSRSSettings(newSettings);
  };

  const handleExport = async () => {
    try {
      const jsonStr = await exportBackupJson();
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kartomat_backup_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Export failed: ' + (err as Error).message);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setImportStatus({ type: 'idle', message: '' });
    const file = files[0];
    const reader = new FileReader();

    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;
        const parsed = JSON.parse(text);
        
        // Basic validation
        if (!parsed.decks && !parsed.learning_programmes) {
          throw new Error('Invalid backup file. Missing decks or programmes.');
        }

        await restoreBackupJson(parsed);
        setImportStatus({ type: 'success', message: 'Database successfully restored!' });
        
        if (onDatabaseReset) {
          onDatabaseReset();
        }
      } catch (err) {
        setImportStatus({ type: 'error', message: 'Restore failed: ' + (err as Error).message });
      }
    };

    reader.readAsText(file);
  };

  const handleCheckUpdates = async () => {
    setCheckingUpdates(true);
    setUpdateMessage('Checking for updates...');

    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.update();
          setTimeout(() => {
            if (!needRefresh) {
              setUpdateMessage('App is already up to date!');
            } else {
              setUpdateMessage('New update available!');
            }
            setCheckingUpdates(false);
          }, 1500);
        } else {
          setUpdateMessage('Service worker not active yet.');
          setCheckingUpdates(false);
        }
      } catch (err) {
        setUpdateMessage('Check failed: ' + (err as Error).message);
        setCheckingUpdates(false);
      }
    } else {
      setUpdateMessage('Service Worker not supported on this browser.');
      setCheckingUpdates(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '550px' }}>
        <div style={{ display: 'flex', justifyContent: 'between', alignItems: 'center', marginBottom: '24px' }}>
          <h2 style={{ fontSize: '1.4rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Sliders size={22} style={{ color: 'var(--color-primary)' }} />
            Settings & Tuning
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', marginLeft: 'auto' }}>
            <X size={20} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* FSRS Tuning Section */}
        <div style={{ marginBottom: '28px' }}>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Sliders size={16} />
            FSRS Scheduler Tuning
          </h3>

          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
              <label className="form-label" style={{ marginBottom: 0 }}>Request Retention</label>
              <span style={{ fontSize: '0.9rem', fontWeight: 'bold', color: 'var(--color-secondary)' }}>
                {Math.round(settings.request_retention * 100)}%
              </span>
            </div>
            <input 
              type="range" 
              min="0.70" 
              max="0.99" 
              step="0.01" 
              value={settings.request_retention} 
              onChange={handleRetentionChange} 
              style={{ width: '100%', accentColor: 'var(--color-secondary)', cursor: 'pointer', height: '6px', borderRadius: '4px' }}
            />
            <div style={{ display: 'flex', gap: '6px', background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', marginTop: '8px', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
              <Info size={14} style={{ flexShrink: 0, marginTop: '2px', color: 'var(--color-secondary)' }} />
              <span>
                Target recall rate. Higher values (e.g. 95%) show cards more frequently to ensure you remember them, whereas lower values (e.g. 80%) spread cards further apart but accept a higher probability of forgetting.
              </span>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Maximum Review Interval (Days)</label>
            <input 
              type="number" 
              className="form-control" 
              min="7" 
              max="36500" 
              value={settings.maximum_interval} 
              onChange={handleMaxIntervalChange} 
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Caps the maximum spacing (in days) between card reviews. Default is 36500 (approx. 100 years).
            </span>
          </div>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '24px 0' }} />

        {/* Database Management Section */}
        <div>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Database size={16} />
            Data Backup & Migration
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <button className="btn btn-secondary" onClick={handleExport} style={{ width: '100%', justifyContent: 'center' }}>
                <Download size={18} />
                Export JSON Backup
              </button>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', textAlign: 'center' }}>
                Download all your decks, card contents, and spaced-repetition progress.
              </p>
            </div>

            <div style={{ position: 'relative', marginTop: '8px' }}>
              <label className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center', cursor: 'pointer' }}>
                <Upload size={18} />
                Import JSON Backup
                <input 
                  type="file" 
                  accept=".json" 
                  onChange={handleImport} 
                  style={{ display: 'none' }} 
                />
              </label>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px', textAlign: 'center' }}>
                Restore your database from a previously exported backup file.
              </p>
            </div>

            {importStatus.type !== 'idle' && (
              <div style={{ 
                padding: '12px', 
                borderRadius: '8px', 
                fontSize: '0.85rem',
                textAlign: 'center',
                background: importStatus.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                color: importStatus.type === 'success' ? 'var(--color-good)' : 'var(--color-again)',
                border: `1px solid ${importStatus.type === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
                marginTop: '8px'
              }}>
                {importStatus.message}
              </div>
            )}
          </div>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '24px 0' }} />

        {/* PWA Version & Updates Section */}
        <div>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <RefreshCw size={16} />
            Version & Updates
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {needRefresh ? (
              <div style={{ padding: '16px', borderRadius: '12px', background: 'rgba(244, 63, 94, 0.08)', border: '1px solid rgba(244, 63, 94, 0.2)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <span style={{ fontSize: '0.9rem', color: 'var(--color-again)', fontWeight: 600 }}>
                  A new app version is available!
                </span>
                <button className="btn btn-primary" onClick={() => updateServiceWorker(true)} style={{ width: '100%' }}>
                  Update App Now
                </button>
              </div>
            ) : (
              <div>
                <button 
                  className="btn btn-secondary" 
                  disabled={checkingUpdates}
                  onClick={handleCheckUpdates} 
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  <RefreshCw size={16} className={checkingUpdates ? 'spin-anim' : ''} style={{ marginRight: '6px' }} />
                  {checkingUpdates ? 'Checking...' : 'Check for Updates'}
                </button>
                <style>{`
                  @keyframes spin { 100% { transform: rotate(360deg); } }
                  .spin-anim { animation: spin 1s linear infinite; }
                `}</style>
                {updateMessage && (
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '8px', textAlign: 'center' }}>
                    {updateMessage}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
