import React, { useState, useEffect, useRef } from 'react';
import {
  Layers, CloudOff, Cloud, Settings as SettingsIcon,
  FolderCog, Archive, Sun, Moon, Monitor, Search, X, Zap, Pen
} from 'lucide-react';
// 🆕 LOCAL-FIRST: sessions live in chrome.storage.local (services/store.js).
// Cloud (services/api.js) is now only an optional sync layer.
import {
  getSessions, createSession, deleteSession,
  restoreBulkSessions, getSettings
} from '../../services/store';
// 🆕 v1 capture — the ONLY way a session is created (locked schema)
import { captureAllWindowsV1, captureCurrentWindowV1 } from '../../services/sessionSchema';
import useTabs from '../hooks/useTabs';
import { dotClassFor } from '../utils/groupColors';
import { filterSessions } from '../utils/sessionSearch';
// 💬 Honest save/restore feedback (Day-3 UX gap: actions must never be silent)
import {
  useFeedback, saveResult, saveFailed, restoreResult
} from '../utils/saveFeedback';
import SessionList from '../components/dashboard/SessionList';
import OrganizePanel from '../components/dashboard/OrganizePanel';
import SaveSession from '../components/dashboard/SaveSession';
import ConfirmModal from '../components/common/ConfirmModal';
import Button from '../components/common/Button';
import Logo from '../components/common/Logo';
import Settings from './Settings';
import RecoveryBanner from '../components/dashboard/RecoveryBanner';
import WelcomeCard from '../components/dashboard/WelcomeCard';

// 🆕 Task 2 auto-name: "Session — Sep 8, 2026 — 10:32 PM"
function autoSessionName() {
  const d = new Date();
  const mon = d.toLocaleString(undefined, { month: 'short' });
  const day = d.getDate();
  const year = d.getFullYear();
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `Session — ${mon} ${day}, ${year} — ${h}:${min} ${ampm}`;
}

export default function Dashboard({ cloudUser, onOpenLogin, onLogout, theme, onCycleTheme }) {
  const [sessions, setSessions] = useState([]);
  // 🆕 Undo toast state — soft-deleted sessions can be restored for 7s after delete
  const [undoInfo, setUndoInfo] = useState(null); // { ids, count }
  const undoTimerRef = useRef(null);
  // 💬 save/restore feedback toast (success / failure / partial)
  const { toast, show, dismiss } = useFeedback();

  // 🖊 MARKUP — open the annotation overlay on the current page (V1.1 MVP).
  // The worker injects our isolated overlay; the website is never modified.
  const openMarkup = async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OPEN_MARKUP' });
      if (res?.ok) {
        window.close(); // let the overlay take over the tab
      } else {
        show('err', "Couldn't open Markup", res?.error || 'Try reloading the page first.');
      }
    } catch (e) {
      show('err', "Couldn't open Markup", String(e?.message || e));
    }
  };
  const { tabs, groupMeta, getCurrentTabs } = useTabs();

  // 🆕 Task 14: primary actions as views — Sessions | Organize | Settings
  const [activeView, setActiveView] = useState('sessions'); // 'sessions' | 'organize' | 'settings'
  // 🆕 Task 2: save scope — all windows (default) or just the current one.
  // The default comes from Settings → General → Save scope.
  const [scope, setScope] = useState('all');
  // 🔍 Search — filters the session list by name or saved tab url/title
  const [query, setQuery] = useState('');
  // 🆕 Task 11: confirm-gated destructive actions
  const [confirm, setConfirm] = useState(null); // { type: 'single'|'bulk', id }
  // ⚙️ Auto-save status — read from the settings the worker actually uses
  const [autoSaveOn, setAutoSaveOn] = useState(true);

  const loadSessions = async () => {
    try {
      const res = await getSessions();
      setSessions(res.data);
    } catch (err) { console.error(err); }
  };

  // 🔍 Filtered view — newest-first order from the store is preserved
  const filteredSessions = filterSessions(sessions, query);

  const showUndo = (ids) => {
    setUndoInfo({ ids, count: ids.length });
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => setUndoInfo(null), 7000);
  };

  useEffect(() => {
    getCurrentTabs();
    loadSessions();
    // ⚙️ Settings → the Save bar preselects the user's chosen default scope,
    // and the header dot mirrors the real auto-save state.
    getSettings().then(s => {
      if (s.defaultScope === 'window') setScope('window');
      setAutoSaveOn(s.autoSave !== false);
    }).catch(() => {});
  }, [getCurrentTabs]);

  // 🆕 v1 SAVE — capture ALL windows through the locked schema module and
  // persist via the local store. The result is FED BACK to the user with real
  // counts — saving is never silent.
  const saveWindowsAs = async (name) => {
    try {
      const windows = scope === 'all'
        ? await captureAllWindowsV1()
        : await captureCurrentWindowV1();
      if (windows.length === 0) {
        show(saveResult(windows)); // "Couldn't save — nothing to save"
        return false;
      }
      const res = await createSession({ name, windows });
      if (!res.data) {
        show(saveFailed('empty'));
        return false;
      }
      show(saveResult(windows)); // "✓ Saved successfully — N tabs · M windows"
      loadSessions();
      return true;
    } catch (err) {
      console.error('Save failed:', err);
      show(saveFailed());
      return false;
    }
  };

  // 🆕 QUICK SAVE — one click; name optional and auto-generated (Task 2)
  const handleQuickSave = async () => saveWindowsAs(autoSessionName());

  // Named save — empty name is fine (auto-name kicks in)
  const handleSaveSession = async (name) => saveWindowsAs(name.trim() || autoSessionName());

  // Restore feedback relay — SessionList reports the worker's counts
  const handleRestoreFeedback = (result) => show(restoreResult(result));

  // 🆕 Task 11: single delete is confirm-gated, then SOFT-deleted with Undo
  const handleDeleteOne = async (id) => {
    setConfirm(null);
    try {
      await deleteSession(id);
      showUndo([id]);
      loadSessions();
    } catch (err) { console.error('Delete failed:', err); }
  };

  // 🆕 UNDO — restore the just-deleted sessions from trash
  const handleUndoDelete = async () => {
    const ids = undoInfo?.ids || [];
    setUndoInfo(null);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    try {
      await restoreBulkSessions(ids);
      loadSessions();
    } catch (err) { console.error('Undo failed:', err); }
  };

  // 🆕 Cleanup the undo timer on unmount
  useEffect(() => () => { if (undoTimerRef.current) clearTimeout(undoTimerRef.current); }, []);

  return (
    <div className="w-full h-full bg-gradient-to-b from-primary to-zinc-100/80 dark:from-primary dark:to-secondary/70 p-5 flex flex-col relative overflow-hidden">

      {/* ── Header: logo + wordmark + tagline, theme + cloud on the right ── */}
      <div className="flex justify-between items-center mb-1.5 relative z-10">
        <div className="flex items-center gap-2.5">
          <Logo size={26} />
          <div>
            <h1 className="text-lg font-bold text-textMain tracking-tight leading-none">
              Orbitabs
            </h1>
            <p className="text-[11px] text-textMuted mt-0.5 leading-none">
              Save your Chrome. Stay in control.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {/* 🖊 Markup this page — annotation overlay (V1.1 MVP) */}
          <Button variant="ghost" onClick={openMarkup} title="Markup this page — draw, highlight and keep notes with this URL" className="p-2">
            <Pen className="w-4 h-4 text-accent" />
          </Button>
          {/* light / dark / system theme cycle — persist in App via useTheme */}
          <Button variant="ghost" onClick={onCycleTheme} title={`Theme: ${theme} (click to change)`} className="p-2">
            {theme === 'dark' ? <Moon className="w-4 h-4 text-accent" />
              : theme === 'light' ? <Sun className="w-4 h-4 text-amber-500" />
              : <Monitor className="w-4 h-4 text-textMuted" />}
          </Button>
          {cloudUser ? (
            <Button variant="ghost" onClick={onLogout} title="Sign out of cloud sync" className="p-2">
              <Cloud className="w-4 h-4 text-accent" />
            </Button>
          ) : (
            <Button variant="ghost" onClick={onOpenLogin} title="Sign in for cloud sync (optional)" className="p-2">
              <CloudOff className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {/* 🆕 TASK 14: primary actions — Sessions | Organize | Settings */}
      <div className="flex items-center gap-1.5 mb-3 relative z-10">
        <button
          onClick={() => setActiveView('sessions')}
          className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors ${activeView === 'sessions' ? 'bg-accent text-onAccent shadow-md' : 'glass text-textMuted hover:text-textMain'}`}
        >
          <Archive size={12} /> Sessions
        </button>
        <button
          onClick={() => setActiveView('organize')}
          className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors ${activeView === 'organize' ? 'bg-accent text-onAccent shadow-md' : 'glass text-textMuted hover:text-textMain'}`}
        >
          <FolderCog size={12} /> Organize
        </button>
        <button
          onClick={() => setActiveView('settings')}
          className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors ${activeView === 'settings' ? 'bg-accent text-onAccent shadow-md' : 'glass text-textMuted hover:text-textMain'}`}
        >
          <SettingsIcon size={12} /> Settings
        </button>
      </div>

      {/* min-h-0 is REQUIRED: without it a flex child defaults to min-height:auto,
          grows to its content height, and the overflow-y-auto views below never
          scroll (Settings was unreachable past the first screen). */}
      <div className="flex-1 min-h-0 flex flex-col relative z-10">
        {activeView === 'sessions' && (
          <>
            <WelcomeCard onQuickSave={handleQuickSave} />

            {/* ── Save bar: the ONE obvious primary action ── */}
            <div className="w-full p-3 rounded-[14px] bg-secondary/60 border border-accent/35 shadow-premium mb-2 relative z-10">
              <button
                onClick={handleQuickSave}
                title="Save every open tab, group and window right now"
                className="w-full flex items-center justify-center gap-2 bg-gradient-to-b from-blue-500 to-blue-700 hover:from-blue-400 hover:to-blue-600 text-onAccent font-semibold text-sm px-5 py-2.5 rounded-[10px] shadow-lg shadow-blue-900/40 transition-colors"
              >
                <Zap size={15} /> Save Current Tabs
              </button>
            </div>

            {/* Clear status line: named save + scope toggle + honest auto-save dot */}
            <div className="flex items-center justify-between gap-2 mb-2 px-1 relative z-10">
              <SaveSession onSave={handleSaveSession} scope={scope} onScopeChange={setScope} compact />
              <span
                title={autoSaveOn
                  ? 'Auto-save is ON — your tabs are continuously protected'
                  : 'Auto-save is OFF — turn it on in Settings'}
                className={`flex items-center gap-1.5 text-[11px] font-medium flex-shrink-0 ${autoSaveOn ? 'text-green-700 dark:text-green-400' : 'text-textMuted'}`}
              >
                <span className={`w-2 h-2 rounded-full ${autoSaveOn ? 'bg-green-500' : 'bg-gray-400'}`} />
                Auto-save {autoSaveOn ? 'ON' : 'OFF'}
              </span>
            </div>

            {groupMeta.length > 0 && (
              <div className="relative z-10 mb-3 flex flex-wrap items-center gap-1.5 px-1">
                <span className="text-textMuted text-xs font-medium mr-1">Groups:</span>
                {groupMeta.map(g => {
                  const count = tabs.filter(t => t.groupId === g.id).length;
                  return (
                    <span
                      key={g.id}
                      className="flex items-center gap-1.5 bg-primary/60 border border-borderLight/60 text-textMain text-xs px-2 py-1 rounded-full"
                    >
                      <span className={`w-2 h-2 rounded-full ${dotClassFor(g.color)}`} />
                      <span className="font-medium">{g.title || 'Untitled'}</span>
                      <span className="text-textMuted">({count})</span>
                    </span>
                  );
                })}
              </div>
            )}

            {activeView === 'sessions' && <RecoveryBanner />}

            {undoInfo && (
              <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-30 bg-secondary text-textMain border border-borderLight text-sm px-4 py-2.5 rounded-xl shadow-premium-lg flex items-center gap-3">
                <span>{undoInfo.count} session{undoInfo.count > 1 ? 's' : ''} moved to Trash</span>
                <button
                  onClick={handleUndoDelete}
                  className="text-amber-500 hover:text-amber-600 font-bold underline underline-offset-2"
                >
                  UNDO
                </button>
              </div>
            )}

            {/* 🔍 Search — filters by session name or saved tab url/title */}
            {sessions.length > 0 && (
              <div className="relative z-10 mb-2">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-textMuted/70 pointer-events-none" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
                  placeholder="Search sessions by name or URL…"
                  className="w-full glass rounded-[10px] pl-9 pr-8 py-2 text-sm text-textMain placeholder:text-textMuted/60 focus:outline-none focus:border-accent/60 border transition-colors"
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    title="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-textMuted hover:text-red-500 transition-colors"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto relative z-10 custom-scrollbar pr-1">
              {sessions.length === 0 ? (
                /* ── Empty state: what will appear here + the CTA ── */
                <div className="flex flex-col items-center justify-center h-full text-textMuted/70 mt-[-20px]">
                  <Layers size={44} className="stroke-1 mb-3 opacity-40" />
                  <p className="text-sm font-medium text-textMain">Your saved sessions will appear here.</p>
                  <p className="text-xs opacity-80 mt-1 mb-4 text-center max-w-[260px]">
                    Save your current Chrome tabs to create your first session.
                  </p>
                  <button
                    onClick={handleQuickSave}
                    className="bg-gradient-to-b from-blue-500 to-blue-700 hover:from-blue-400 hover:to-blue-600 text-onAccent text-sm font-semibold px-4 py-2 rounded-[10px] shadow-md shadow-blue-900/40 transition-colors"
                  >
                    <span className="flex items-center gap-1.5"><Zap size={14} /> Save Current Tabs</span>
                  </button>
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-textMuted/60 mt-[-20px]">
                  <Search size={44} className="stroke-1 mb-3 opacity-50" />
                  <p className="text-sm font-medium">No sessions match “{query.trim()}”</p>
                  <p className="text-xs opacity-70">Try a different name or URL</p>
                </div>
              ) : (
                <SessionList
                  sessions={filteredSessions}
                  onDelete={(id) => setConfirm({ type: 'single', id })}
                  onRenamed={loadSessions}
                  onRestoreResult={handleRestoreFeedback}
                />
              )}
            </div>
          </>
        )}

        {activeView === 'organize' && (
          <div className="flex-1 min-h-0 overflow-y-auto relative z-10 custom-scrollbar pr-1">
            <OrganizePanel />
          </div>
        )}

        {activeView === 'settings' && (
          <div className="flex-1 min-h-0 overflow-y-auto relative z-10 custom-scrollbar pr-1">
            <Settings
              cloudUser={cloudUser}
              theme={theme}
              onCycleTheme={onCycleTheme}
              onBack={() => setActiveView('sessions')}
              onOpenLogin={(mode) => onOpenLogin?.(mode === 'register' ? 'register' : 'login')}
            />
          </div>
        )}
      </div>

      {/* 💬 Feedback toast — success / failure / partial, honest counts */}
      {toast && (
        <button
          onClick={dismiss}
          title="Dismiss"
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-[92%] text-left px-4 py-2.5 rounded-xl shadow-premium-lg border text-sm ${
            toast.kind === 'ok'
              ? 'bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-900 text-green-800 dark:text-green-300'
              : toast.kind === 'warn'
                ? 'bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300'
                : 'bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
          }`}
        >
          <span className="font-semibold block">
            {toast.kind === 'ok' ? '✓ ' : '⚠ '}{toast.title}
          </span>
          {toast.detail && <span className="text-xs opacity-80 block mt-0.5">{toast.detail}</span>}
        </button>
      )}

      {/* 🆕 TASK 11: confirm-gated destructive actions — never instant loss */}
      <ConfirmModal
        open={confirm?.type === 'single'}
        title="Move to Trash?"
        message="You can restore it from Trash anytime within 30 days."
        confirmLabel="Move to Trash"
        cancelLabel="Cancel"
        danger
        onConfirm={() => handleDeleteOne(confirm?.id)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
