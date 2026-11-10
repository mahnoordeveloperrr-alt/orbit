import React, { useState, useEffect, useRef } from 'react';
import {
  Layers, Settings as SettingsIcon,
  FolderCog, Archive, Contrast, Search, X, Zap, PenTool
} from 'lucide-react';
// 🆕 LOCAL-FIRST: sessions live in chrome.storage.local (services/store.js).
// Cloud (services/api.js) is now only an optional sync layer.
import {
  getSessions, createSession, deleteSession,
  restoreBulkSessions, getSettings, setSetting
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
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const saveBusyRef = useRef(false);
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
  // 🆕 V1.5 — folder filter chips (folders = the union of session.folder)
  const [activeFolder, setActiveFolder] = useState(null);
  // 🆕 Task 11: confirm-gated destructive actions
  const [confirm, setConfirm] = useState(null); // { type: 'single'|'bulk', id }
  // ⚙️ Auto-save status — read from the settings the worker actually uses
  const [autoSaveOn, setAutoSaveOn] = useState(true);

  const loadSessions = async () => {
    setSessionsLoading(true);
    setSessionsError('');
    try {
      const res = await getSessions();
      setSessions(res.data);
    } catch (err) {
      console.error('Saved sessions could not be loaded:', err);
      setSessionsError('Could not load saved sessions. Check browser storage and try again.');
    } finally { setSessionsLoading(false); }
  };

  // 🆕 V1.5 — every folder in use (no separate store; folders ARE the union)
  const allFolders = [...new Set(
    sessions.map(s => s?.folder).filter(f => typeof f === 'string' && f.trim())
  )].slice(0, 30);

  // 🔍 Filtered view — newest-first order from the store is preserved.
  //     Folder filter (chips) composes with the search query — both must match.
  const folderFiltered = activeFolder
    ? sessions.filter(s => s?.folder === activeFolder)
    : sessions;
  const filteredSessions = filterSessions(folderFiltered, query);

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
    if (saveBusyRef.current) return false;
    saveBusyRef.current = true;
    setSaveBusy(true);
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
      // Surface the real reason (e.g. storage-full from writeAll) so the
      // user can act — never a silent failure or a generic dead-end.
      show(saveFailed(err?.message || ''));
      return false;
    } finally {
      saveBusyRef.current = false;
      setSaveBusy(false);
    }
  };

  // 🆕 QUICK SAVE — one click; name optional and auto-generated (Task 2)
  const handleQuickSave = async () => saveWindowsAs(autoSessionName());

  // Named save — empty name is fine (auto-name kicks in)
  const handleSaveSession = async (name) => saveWindowsAs((name || '').trim() || autoSessionName());

  // 🆕 Auto-save button — the status dot is now a real control: one click
  // toggles the persisted autoSave setting (the same key Settings writes).
  const toggleAutoSave = async () => {
    const next = !autoSaveOn;
    setAutoSaveOn(next);
    try {
      await setSetting({ autoSave: next });
    } catch (err) {
      console.error('Auto-save toggle failed:', err);
      setAutoSaveOn(!next); // honest UI: roll back if the write failed
    }
  };

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
    <div className="w-full h-full bg-primary p-5 flex flex-col relative overflow-hidden">

      {/* ── Header: centered brand block + corner actions, per the light
          mock: THEME control sits LEFT, the markup tool RIGHT; both
          live ONLY in the header corners; the nav row stays pills-only.
          Icons swapped on request: Contrast replaces the Moon (it reads as
          a display-mode switch in BOTH themes, unlike a lone moon), PenTool
          replaces the plain Pen (a nib says "annotate" and stays sharp at
          16px). ── */}
      <div className="rise relative flex items-center justify-center mb-3" style={{ '--d': '20ms' }}>
        <Button variant="ghost" onClick={onCycleTheme} title={`Theme: ${theme} (click to change)`} className="icon-btn absolute left-0 p-2">
          {/* Contrast (half-filled circle) = theme switcher, not a state
              badge — same glyph in both themes. White on dark tokens, dark
              ink on the light page. (Only light ⇄ dark — system mode was
              removed on request.) */}
          {theme === 'dark' ? <Contrast className="w-4 h-4 text-white" />
            : <Contrast className="w-4 h-4 text-textMain" />}
        </Button>
        <div className="flex flex-col items-center">
          <h1 className="sr-only">Orbitabs</h1>
          <img
            src="/brand/orbitabs-wordmark.png"
            alt="Orbitabs"
            className={`h-12 w-48 object-contain ${theme === 'light' ? 'invert' : ''}`}
          />
          <p className="text-[10px] text-textMuted mt-1 leading-none">
            Save your Chrome. Stay in control.
          </p>
        </div>
        <Button variant="ghost" onClick={openMarkup} title="Markup this page — draw, highlight and keep notes with this URL" className="icon-btn absolute right-0 p-2">
          <PenTool className="w-4 h-4" />
        </Button>
      </div>

      {/* 🆕 TASK 14: primary actions row — pills only (theme/pen live in the
          header corners; spec §7 segmented nav). `.nav-row` carries the light
          mock's full-bleed hairline under the pills; `.nav-pill` / the
          active flag drive the capsule + sage/grey fills in light mode. */}
      <div className="nav-row rise relative z-10 flex items-center justify-center mb-4" style={{ '--d': '70ms' }}>
        <div className="flex items-center gap-1.5">
          {[['sessions', Archive, 'Sessions'], ['organize', FolderCog, 'Organizer'], ['settings', SettingsIcon, 'Settings']].map(([key, Icon, label]) => (
            <button
              key={key}
              onClick={() => {
                setActiveView(key);
                // Returning from Settings: re-sync the auto-save button with
                // the real setting (Settings writes the same storage key).
                if (key === 'sessions') getSettings().then(s => setAutoSaveOn(s.autoSave !== false)).catch(() => {});
              }}
              className={`nav-pill flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-[10px] transition-colors duration-150 ${
                activeView === key
                  ? 'is-active bg-accent text-accentInk'
                  : 'surface border border-borderLight text-textMuted hover:text-textMain'
              }`}
            >
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>
      </div>

      {/* min-h-0 is REQUIRED: without it a flex child defaults to min-height:auto,
          grows to its content height, and the overflow-y-auto views below never
          scroll (Settings was unreachable past the first screen). */}
      <div className="flex-1 min-h-0 flex flex-col relative z-10">
        {activeView === 'sessions' && (
          <>
            {/* Soft entrance — wrapped so the card joins the staggered
                rise choreography (Material decelerate, 100ms step). */}
            <div className="rise" style={{ '--d': '100ms' }}>
              <WelcomeCard onQuickSave={handleQuickSave} busy={saveBusy} />
            </div>

            {/* ── PRIMARY ACTION — spec §8: big green save, unambiguous labels.
                In light mode `.save-cta-box` drops the wrapper chrome so the
                button sits bare on white, like the mock. ── */}
            <div className="save-cta-box rise surface border border-accent/30 rounded-[14px] p-3 mb-2 relative z-10" style={{ '--d': '130ms' }}>
              <button
                onClick={handleQuickSave}
                disabled={saveBusy}
                title="Save every open tab, group and window right now"
                className="save-btn w-full flex items-center justify-center gap-2 font-semibold text-sm px-5 py-2.5 rounded-[10px] transition-colors duration-150 disabled:opacity-60 disabled:cursor-wait"
              >
                <Zap size={15} /> SAVE CURRENT TABS
              </button>
            </div>

            {/* Status line: the uniform centered trio — scope toggle,
                secondary Save, auto-save button (all w-[110px] h-7) */}
            <div className="rise flex items-center justify-center gap-1.5 mb-2 px-1 relative z-10" style={{ '--d': '170ms' }}>
              <SaveSession onSave={handleSaveSession} scope={scope} onScopeChange={setScope} compact variant="outline" disabled={saveBusy} />
              <button
                onClick={toggleAutoSave}
                title={autoSaveOn
                  ? 'Auto-save is ON — click to turn it off'
                  : 'Auto-save is OFF — click to turn it on'}
                className={`auto-btn ${autoSaveOn ? 'is-on' : ''} flex items-center justify-center gap-1.5 w-[110px] h-7 rounded-[10px] text-xs font-medium border flex-shrink-0 transition-colors duration-150 ${autoSaveOn
                  ? 'text-green-700 dark:text-green-400 border-green-500/40 bg-green-500/10 hover:bg-green-500/20'
                  : 'text-textMuted border-borderLight hover:text-textMain'}`}
              >
                <span className={`auto-dot w-2 h-2 rounded-full ${autoSaveOn ? 'bg-green-500' : 'bg-gray-400'}`} />
                Auto-save {autoSaveOn ? 'ON' : 'OFF'}
              </button>
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
              <div className="toast-in absolute bottom-16 left-1/2 -translate-x-1/2 z-30 bg-secondary text-textMain border border-borderLight text-sm px-4 py-2.5 rounded-xl shadow-premium-lg flex items-center gap-3">
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
              <div className="rise relative z-10 mb-2" style={{ '--d': '200ms' }}>
                <Search size={14} className="search-icon absolute left-3 top-1/2 -translate-y-1/2 text-textMuted/70 pointer-events-none" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
                  placeholder="Search saved sessions…"
                  className="search-input w-full surface rounded-[10px] pl-9 pr-8 py-2 text-sm text-textMain placeholder:text-textMuted/60 focus:outline-none focus:border-accent/70 border transition-colors"
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    title="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-textMuted hover:text-red-500 hover:scale-110 transition-all"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            )}

            {/* 🆕 V1.5 — folder chips: one tap to scope the list to a folder */}
            {allFolders.length > 0 && (
              <div className="rise flex flex-wrap items-center gap-1.5 mb-2 px-1 relative z-10" style={{ '--d': '210ms' }}>
                <button
                  onClick={() => setActiveFolder(null)}
                  className={`text-[10px] font-medium px-2 py-1 rounded-full border transition-colors ${!activeFolder
                    ? 'bg-accent text-accentInk border-accent'
                    : 'surface text-textMuted border-borderLight/60 hover:text-textMain'}`}
                >
                  All
                </button>
                {allFolders.map(f => (
                  <button
                    key={f}
                    onClick={() => setActiveFolder(prev => prev === f ? null : f)} // toggle — click again to clear
                    className={`flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-full border transition-colors ${activeFolder === f
                      ? 'bg-accent text-accentInk border-accent'
                      : 'surface text-textMuted border-borderLight/60 hover:text-textMain'}`}
                  >
                    <FolderCog size={9} /> {f}
                  </button>
                ))}
              </div>
            )}

            {/* Section label — the ui/ reference's small left-anchored list title */}
            {sessions.length > 0 && (
              <div className="rise flex items-center justify-between px-1 mb-1.5 relative z-10" style={{ '--d': '220ms' }}>
                <span className="text-[10px] font-semibold tracking-wider uppercase text-textMuted">Saved sessions</span>
                <span className="text-[10px] text-textMuted">{filteredSessions.length}</span>
              </div>
            )}

            {sessionsError && sessions.length > 0 && (
              <div role="alert" className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                <span>Could not refresh sessions. Showing the last loaded list.</span>
                <button onClick={loadSessions} className="font-semibold underline underline-offset-2">Retry</button>
              </div>
            )}
            <div className="rise flex-1 min-h-0 overflow-y-auto relative z-10 custom-scrollbar pr-1" style={{ '--d': '240ms' }}>
              {sessionsLoading && sessions.length === 0 ? (
                <div className="flex flex-col gap-2 p-1" role="status" aria-label="Loading saved sessions">
                  {[0, 1, 2].map((item) => <div key={item} className="h-16 rounded-xl border border-border bg-secondary/60 animate-pulse" />)}
                </div>
              ) : sessionsError && sessions.length === 0 ? (
                <div role="alert" className="flex flex-col items-center justify-center h-full text-center px-4">
                  <p className="text-sm font-semibold text-red-600 dark:text-red-400">Saved sessions could not be loaded</p>
                  <p className="text-xs text-textMuted mt-1 mb-3">{sessionsError}</p>
                  <button onClick={loadSessions} className="px-3 py-1.5 rounded-lg border border-borderLight text-sm font-medium hover:bg-secondary">Try again</button>
                </div>
              ) : sessions.length === 0 ? (
                /* ── Empty state: what will appear here + the CTA ── */
                <div className="flex flex-col items-center justify-center h-full text-textMuted/70 mt-[-20px]">
                  <Layers size={44} className="stroke-1 mb-3 opacity-40" />
                  <p className="text-sm font-medium text-textMain">Your saved sessions will appear here.</p>
                  <p className="text-xs opacity-80 mt-1 mb-4 text-center max-w-[260px]">
                    Save your current Chrome tabs to create your first session.
                  </p>
                  <button
                    onClick={handleQuickSave}
                    disabled={saveBusy}
                    className="save-btn text-sm font-semibold px-4 py-2 rounded-[10px] transition-colors disabled:opacity-60 disabled:cursor-wait"
                  >
                    <span className="flex items-center gap-1.5"><Zap size={14} /> Save Current Tabs</span>
                  </button>
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-textMuted/60 mt-[-20px]">
                  <Search size={44} className="stroke-1 mb-3 opacity-50" />
                  {/* Honest empty copy for BOTH filters — query and/or folder */}
                  <p className="text-sm font-medium">
                    {query.trim()
                      ? <>No sessions match “{query.trim()}”{activeFolder && <> in {activeFolder}</>}</>
                      : <>No sessions in “{activeFolder}”</>}
                  </p>
                  <p className="text-xs opacity-70">
                    {query.trim() ? 'Try a different name, tag or URL' : 'Pick another folder or clear the filter'}
                  </p>
                </div>
              ) : (
                <SessionList
                  sessions={filteredSessions}
                  onDelete={(id) => setConfirm({ type: 'single', id })}
                  onRenamed={loadSessions}
                  onRestoreResult={handleRestoreFeedback}
                  onRestored={loadSessions} /* 🕘 B7 — version restore → reload */
                />
              )}
            </div>
          </>
        )}

        {activeView === 'organize' && (
          <div className="view-enter flex-1 min-h-0 overflow-y-auto relative z-10 custom-scrollbar pr-1">
            <OrganizePanel />
          </div>
        )}

        {activeView === 'settings' && (
          <div className="view-enter flex-1 min-h-0 overflow-y-auto relative z-10 custom-scrollbar pr-1">
            <Settings
              cloudUser={cloudUser}
              theme={theme}
              onCycleTheme={onCycleTheme}
              onBack={() => setActiveView('sessions')}
              onOpenLogin={(mode) => onOpenLogin?.(mode === 'register' ? 'register' : 'login')}
              onLogout={onLogout}
            />
          </div>
        )}
      </div>

      {/* 💬 Feedback toast — success / failure / partial, honest counts */}
      {toast && (
        <button
          onClick={dismiss}
          title="Dismiss"
          className={`toast-in absolute bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-[92%] text-left px-4 py-2.5 rounded-xl shadow-premium-lg border text-sm ${
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
