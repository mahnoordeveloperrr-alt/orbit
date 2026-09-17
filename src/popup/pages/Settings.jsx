import React, { useEffect, useState } from 'react';
import {
  ArrowLeft, Shield, Palette, Cloud, CloudOff, HardDrive, RefreshCw,
  Download, Upload, Trash2, Keyboard, SlidersHorizontal,
  RotateCcw, Eraser, History, XCircle
} from 'lucide-react';
import {
  getSettings, setSetting, getSessions, importSessions,
  emptyTrash, resetAllLocalData, getLocalDataStats
} from '../../services/store';
import { downloadBackupFile, pickBackupFile, parseBackupText } from '../utils/sessionBackup';
import ConfirmModal from '../components/common/ConfirmModal';

// 🧭 Settings — the user's control room. Every control here maps to a REAL
// behavior switch read by the worker (public/background.js) or the store
// (services/store.js). Defaults are the local-first experience: protection
// on, cloud off, account never required.

// NB: no option below the 30s floor — Chrome MV3 alarms cannot fire faster
// than 0.5 min, and the worker clamps lower values to 30. Never offer what
// the platform silently discards.
const FREQ_OPTIONS = [
  { value: 30, label: 'Every 30 seconds (most protection)' },
  { value: 60, label: 'Every 60 seconds (recommended)' },
  { value: 300, label: 'Every 5 minutes (lightest)' },
];
const RING_OPTIONS = [3, 5, 10];
const RETENTION_OPTIONS = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days (recommended)' },
];

export default function Settings({ cloudUser, theme, onCycleTheme, onBack, onOpenLogin }) {
  const [settings, setSettings] = useState(null);
  const [diag, setDiag] = useState(null);
  // 📦 Export / import status line
  const [backupMsg, setBackupMsg] = useState(null); // { kind: 'ok' | 'err', text }
  const [backupBusy, setBackupBusy] = useState(false);
  // 🧹 Data-management status + confirm-gated destructive actions
  const [dataMsg, setDataMsg] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'trash' | 'recovery' | 'reset'

  useEffect(() => {
    getSettings().then(setSettings).catch(() => {});
    loadDiag();
  }, []);

  const update = async (patch) => setSettings(await setSetting(patch));

  const loadDiag = async () => {
    try {
      const d = await chrome.storage.local.get([
        'snapshot', 'snapshotAt', 'lastAlive', 'cleanExit',
        'recoveryPoints', 'recoveryCandidate'
      ]);
      const tabs = (d.snapshot?.windows || []).reduce((n, w) => n + (w.tabs?.length || 0), 0);
      setDiag({
        snapshotAgeSec: d.snapshotAt ? Math.round((Date.now() - d.snapshotAt) / 1000) : null,
        heartbeatAgeSec: d.lastAlive ? Math.round((Date.now() - d.lastAlive) / 1000) : null,
        liveTabs: tabs,
        liveWindows: d.snapshot?.windows?.length || 0,
        cleanExit: d.cleanExit === true ? 'Yes' : d.cleanExit === false ? 'No (running)' : 'Unknown',
        recoveryPoints: (d.recoveryPoints || []).map(p => ({
          savedAt: p.savedAt || null,
          tabs: (p.windows || []).reduce((n, w) => n + (w.tabs?.length || 0), 0),
          windows: (p.windows || []).length
        })),
        crashQueued: !!d.recoveryCandidate
      });
    } catch { setDiag(null); }
  };

  const handleRestorePoint = async (index) => {
    try {
      await chrome.runtime.sendMessage({ type: 'RESTORE_RECOVERY_POINT', index });
      setTimeout(loadDiag, 800);
    } catch (err) { console.error(err); }
  };

  /* ---------------- 💾 Recovery history maintenance ---------------- */

  const clearRecoveryData = async () => {
    setConfirm(null);
    try {
      await chrome.storage.local.remove(['recoveryPoints', 'recoveryCandidate', 'crashDetectedAt']);
      setDataMsg({ kind: 'ok', text: 'Recovery history cleared ✓' });
      loadDiag();
    } catch (e) {
      setDataMsg({ kind: 'err', text: 'Could not clear recovery data: ' + (e.message || e) });
    }
  };

  /* ---------------- 📦 Export / import ---------------- */

  const handleExport = async () => {
    try {
      setBackupBusy(true);
      const res = await getSessions();
      const { filename, count } = downloadBackupFile(res.data);
      setBackupMsg(count === 0
        ? { kind: 'err', text: 'No sessions to export yet — save one first.' }
        : { kind: 'ok', text: `Exported ${count} session${count === 1 ? '' : 's'} → ${filename}` });
    } catch (e) {
      setBackupMsg({ kind: 'err', text: 'Export failed: ' + (e.message || e) });
    }
    setBackupBusy(false);
  };

  const handleImport = async () => {
    try {
      setBackupBusy(true);
      const { text, filename } = await pickBackupFile(); // rejects {cancelled} when dialog dismissed
      const parsed = parseBackupText(text); // throws user-safe messages on bad files
      if (parsed.sessions.length === 0) {
        setBackupMsg({
          kind: 'err',
          text: `"${filename}" has no restorable sessions` + (parsed.skipped ? ` (${parsed.skipped} bad entr${parsed.skipped === 1 ? 'y' : 'ies'} skipped)` : '') + '.'
        });
        return;
      }
      const ok = window.confirm(
        `Import ${parsed.sessions.length} session${parsed.sessions.length === 1 ? '' : 's'} from "${filename}"?\n\n` +
        'They will be ADDED to your list — nothing is overwritten.'
      );
      if (!ok) return;
      const { imported, skipped, duplicates } = await importSessions(parsed);
      const notes = [
        duplicates ? `${duplicates} duplicate${duplicates === 1 ? '' : 's'} already present` : null,
        skipped ? `${skipped} bad entr${skipped === 1 ? 'y' : 'ies'} skipped` : null,
      ].filter(Boolean).join(' — ');
      setBackupMsg({
        kind: 'ok',
        text: (imported
          ? `Imported ${imported} session${imported === 1 ? '' : 's'}`
          : 'Nothing new to import') + (notes ? ` — ${notes}` : '') + ' ✓'
      });
    } catch (e) {
      if (!e?.cancelled) setBackupMsg({ kind: 'err', text: e.message || 'Import failed.' });
    }
    setBackupBusy(false);
  };

  /* ---------------- 🧹 Reset / purge ---------------- */

  const clearTrash = async () => {
    setConfirm(null);
    try {
      const res = await emptyTrash();
      setDataMsg({ kind: 'ok', text: res.data?.message || 'Trash emptied.' });
    } catch (e) {
      setDataMsg({ kind: 'err', text: 'Could not empty trash: ' + (e.message || e) });
    }
  };

  const resetOrbitabs = async () => {
    setConfirm(null);
    try {
      await resetAllLocalData();
      setSettings(await getSettings()); // back to defaults
      setDataMsg({ kind: 'ok', text: 'Orbitabs reset — all local data erased, defaults restored.' });
      loadDiag();
    } catch (e) {
      setDataMsg({ kind: 'err', text: 'Reset failed: ' + (e.message || e) });
    }
  };

  const askReset = async () => {
    // The confirmation states exactly what will be erased, with live counts.
    let stats = { sessions: 0, trashed: 0, tabs: 0 };
    try { stats = (await getLocalDataStats()).data; } catch { /* fall back to zeros */ }
    setConfirm({ type: 'reset', stats });
  };

  /* ---------------- ⌨️ Shortcuts ---------------- */

  const openShortcutSettings = () => {
    // Real Chrome: the shortcuts manager. In non-extension contexts this is a
    // harmless no-op (the button still explains where to go).
    try { chrome.tabs?.create?.({ url: 'chrome://extensions/shortcuts' }); } catch { /* noop */ }
  };

  if (!settings) {
    return (
      <div className="w-full h-full bg-gradient-to-br from-blue-50 via-blue-100 to-blue-200 p-5 flex flex-col relative overflow-hidden">
        <Header onBack={onBack} />
        <div className="flex-1 flex items-center justify-center text-textMuted text-sm">Loading settings…</div>
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-gradient-to-br from-blue-50 via-blue-100 to-blue-200 dark:from-slate-900 dark:via-slate-900 dark:to-slate-800 p-5 flex flex-col relative overflow-hidden">
      <div className="absolute top-0 right-0 w-64 h-64 bg-blue-300 rounded-full blur-3xl opacity-40 pointer-events-none"></div>

      <Header onBack={onBack} />

      <div className="flex-1 overflow-y-auto relative z-10 custom-scrollbar space-y-4">

        {/* ═══════════ ⚙️ GENERAL ═══════════ */}
        <Section icon={<SlidersHorizontal size={16} />} title="General">

          <Row
            title="Auto-save"
            desc="Continuously protect your open tabs so a crash never loses them"
          >
            <Toggle checked={settings.autoSave} onChange={() => update({ autoSave: !settings.autoSave })} />
          </Row>

          {settings.autoSave && (
            <Row
              title="Auto-save frequency"
              desc="How often your live state is snapshotted"
            >
              <select
                value={settings.autoSaveFreqSec}
                onChange={(e) => update({ autoSaveFreqSec: Number(e.target.value) })}
                className="text-xs rounded-lg border border-blue-200 dark:border-borderLight bg-white dark:bg-secondary px-2 py-1.5 text-blue-800 dark:text-blue-300 font-medium focus:outline-none"
              >
                {FREQ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Row>
          )}

          <Row
            title="Save scope"
            desc="Save button captures ALL open windows, or only the Current window (also settable per-save in the popup)"
          >
            <Segmented
              value={settings.defaultScope}
              options={[{ value: 'all', label: 'All windows' }, { value: 'window', label: 'Current window' }]}
              onChange={(v) => update({ defaultScope: v })}
            />
          </Row>

          <Row
            title="Restore behavior"
            desc="'Current window' restores into THIS window — its existing tabs are closed first; 'New window' never touches what you have open"
          >
            <Segmented
              value={settings.restoreBehavior}
              options={[{ value: 'new', label: 'New window' }, { value: 'current', label: 'Current window' }]}
              onChange={(v) => update({ restoreBehavior: v })}
            />
          </Row>

          <Row title="Restore pinned tabs" desc="Keep pinned tabs pinned, in the pinned block">
            <Toggle checked={settings.restorePinned} onChange={() => update({ restorePinned: !settings.restorePinned })} />
          </Row>
          <Row title="Restore active tab" desc="Re-focus the tab that was active when saved">
            <Toggle checked={settings.restoreActive} onChange={() => update({ restoreActive: !settings.restoreActive })} />
          </Row>
          <Row title="Restore Chrome tab groups" desc="Rebuild groups with title, color and collapsed state">
            <Toggle checked={settings.restoreGroups} onChange={() => update({ restoreGroups: !settings.restoreGroups })} />
          </Row>
        </Section>

        {/* ═══════════ 💾 BACKUP & RECOVERY ═══════════ */}
        <Section icon={<HardDrive size={16} />} title="Backup & Recovery">

          <Row
            title="Live Backup"
            desc="Keep an always-current “Auto-save — Live Backup” session at the top of your list (local, no account)"
          >
            <Toggle checked={settings.liveBackup} onChange={() => update({ liveBackup: !settings.liveBackup })} />
          </Row>

          <Row
            title="Crash Recovery"
            desc="Detect a Chrome crash and offer your tabs back"
          >
            <Toggle checked={settings.crashRecovery} onChange={() => update({ crashRecovery: !settings.crashRecovery })} />
          </Row>

          <Row title="Maximum recovery points" desc="History of recent snapshots kept for manual restore">
            <select
              value={settings.maxRecoveryPoints}
              onChange={(e) => update({ maxRecoveryPoints: Number(e.target.value) })}
              className="text-xs rounded-lg border border-blue-200 dark:border-borderLight bg-white dark:bg-secondary px-2 py-1.5 text-blue-800 dark:text-blue-300 font-medium focus:outline-none"
            >
              {RING_OPTIONS.map(n => <option key={n} value={n}>{n} points</option>)}
            </select>
          </Row>

          <Row title="Trash retention" desc="Trashed sessions are auto-deleted after this window">
            <select
              value={settings.trashRetentionDays}
              onChange={(e) => update({ trashRetentionDays: Number(e.target.value) })}
              className="text-xs rounded-lg border border-blue-200 dark:border-borderLight bg-white dark:bg-secondary px-2 py-1.5 text-blue-800 dark:text-blue-300 font-medium focus:outline-none"
            >
              {RETENTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Row>

          <div className="flex gap-2 pt-1">
            <button
              onClick={() => setConfirm({ type: 'recovery' })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-xs font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
            >
              <Eraser size={12} /> Clear recovery data
            </button>
            <button
              onClick={() => setConfirm({ type: 'trash' })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-xs font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
            >
              <Trash2 size={12} /> Clear trash
            </button>
          </div>

          {/* Recovery history — the existing diagnostics ring, restorable per point */}
          <RecoveryHistory diag={diag} onRestore={handleRestorePoint} onRefresh={loadDiag} />
        </Section>

        {/* ═══════════ 🔐 PRIVACY & DATA ═══════════ */}
        <Section icon={<Shield size={16} />} title="Privacy & Data">

          <Row
            title="Local-only mode"
            desc="Hard guarantee: Orbitabs makes zero network calls. Cloud sync turns off with it."
          >
            <Toggle checked={settings.localOnly} onChange={() => update({ localOnly: !settings.localOnly })} />
          </Row>

          <Row
            title="Cloud sync"
            desc={cloudUser
              ? 'Copy saved sessions to your account (optional — local stays primary)'
              : 'Optional — needs an account. Everything already works without it.'}
          >
            <Toggle
              checked={settings.cloudSync && !settings.localOnly}
              onChange={() => {
                if (settings.localOnly) return; // local-only wins — no network, ever
                if (!cloudUser && !settings.cloudSync) {
                  setBackupMsg({ kind: 'err', text: 'Cloud sync needs an account — use Sign in below. Your local data is already fully protected without it.' });
                  return;
                }
                update({ cloudSync: !settings.cloudSync });
              }}
            />
          </Row>

          {/* What data Orbitabs stores — plain-English guarantees */}
          <ul className="text-[11px] text-textMuted space-y-1.5 leading-relaxed mt-1">
            <li>✅ Sessions, auto-save snapshots, and settings live only in <span className="font-semibold text-textMain">this browser's local storage</span> — they work offline.</li>
            <li>✅ Nothing is uploaded anywhere unless you sign in AND turn on cloud sync — and then only your saved sessions.</li>
            <li>✅ No analytics, no tracking, no ads. The only network call is your own backend when cloud sync is on.</li>
            <li>🚫 Orbitabs never reads page content, never changes tabs you didn't act on, and never deletes without a confirm dialog.</li>
          </ul>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleExport}
              disabled={backupBusy}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-sm font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors disabled:opacity-50"
            >
              <Download size={14} /> Export all data
            </button>
            <button
              onClick={handleImport}
              disabled={backupBusy}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-sm font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors disabled:opacity-50"
            >
              <Upload size={14} /> Import data
            </button>
          </div>
          <p className="text-[11px] text-textMuted leading-relaxed">
            Export saves every session (trash excluded) as one portable JSON file —
            share it or import it on another machine. Imports are added to your
            list; existing sessions are never overwritten. Works offline, no account.
          </p>
          {backupMsg && (
            <p className={`text-xs mt-1 font-medium ${backupMsg.kind === 'ok' ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {backupMsg.text}
            </p>
          )}

          <button
            onClick={askReset}
            className="w-full mt-2 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 text-sm font-medium hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
          >
            <XCircle size={14} /> Delete all local data
          </button>
        </Section>

        {/* ═══════════ ☁️ ACCOUNT / SYNC ═══════════ */}
        <Section icon={cloudUser ? <Cloud size={16} /> : <CloudOff size={16} />} title="Account / Sync">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm font-medium text-textMain">
                {cloudUser ? 'Account connected' : 'Account: Not connected'}
              </p>
              <p className="text-xs text-textMuted">
                {cloudUser
                  ? 'Cloud sync available — your local data stays primary'
                  : 'Everything already works without an account'}
              </p>
            </div>
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${
              cloudUser ? 'bg-green-100 dark:bg-green-950/50 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400'
            }`}>
              {cloudUser ? '✓ Connected' : 'Local'}
            </span>
          </div>
          {!cloudUser && (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onOpenLogin?.('login')}
                className="px-3 py-2 rounded-lg bg-blue-700 dark:bg-blue-500 text-white text-sm font-semibold hover:bg-blue-800 dark:hover:bg-blue-400 transition-colors shadow-sm"
              >
                Sign in
              </button>
              <button
                onClick={() => onOpenLogin?.('register')}
                className="px-3 py-2 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-sm font-semibold hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
              >
                Create account
              </button>
            </div>
          )}
          <button
            onClick={onBack}
            className="w-full mt-2 text-xs text-textMuted hover:text-textMain font-medium"
          >
            {cloudUser ? 'Back to the app' : 'Continue without account →'}
          </button>
          <p className="text-[11px] text-textMuted/80 mt-2 italic">
            Cloud sync is clearly optional: saved sessions, Live Backup, crash
            recovery and export/import all work fully offline.
          </p>
        </Section>

        {/* ═══════════ ⌨️ KEYBOARD SHORTCUTS ═══════════ */}
        <Section icon={<Keyboard size={16} />} title="Keyboard Shortcuts">
          <table className="w-full text-xs">
            <tbody>
              {[
                ['Save session', 'Alt+Shift+S'],
                ['Restore session', 'Alt+Shift+R'],
                ['Open Orbitabs', 'Alt+Shift+O'],
              ].map(([label, keys]) => (
                <tr key={label} className="border-b border-blue-50 last:border-0">
                  <td className="py-1.5 text-textMain font-medium">{label}</td>
                  <td className="py-1.5 text-right">
                    <kbd className="px-2 py-0.5 rounded bg-blue-50 dark:bg-secondary border border-blue-200 dark:border-borderLight text-blue-800 dark:text-blue-300 font-mono text-[11px]">{keys}</kbd>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-textMuted/70 mt-1 italic">
            Default keys shown — they may differ if you remapped them.
          </p>
          <button
            onClick={openShortcutSettings}
            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-xs font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
          >
            <Keyboard size={12} /> Change in Chrome's shortcut settings
          </button>
        </Section>

        {/* ═══════════ 🗑️ DATA MANAGEMENT ═══════════ */}
        <Section icon={<Trash2 size={16} />} title="Data Management">
          <div className="grid grid-cols-2 gap-2">
            <button onClick={handleExport} disabled={backupBusy}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-sm font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors disabled:opacity-50">
              <Download size={13} /> Export
            </button>
            <button onClick={handleImport} disabled={backupBusy}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-sm font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors disabled:opacity-50">
              <Upload size={13} /> Import
            </button>
            <button onClick={() => setConfirm({ type: 'trash' })}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-sm font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors">
              <Trash2 size={13} /> Empty Trash
            </button>
            <button onClick={() => setConfirm({ type: 'recovery' })}
              className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-sm font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors">
              <History size={13} /> Clear recovery history
            </button>
          </div>
          <button
            onClick={askReset}
            className="w-full mt-2 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-500 text-white text-sm font-semibold hover:bg-red-600 transition-colors shadow-sm"
          >
            <RotateCcw size={14} /> Reset Orbitabs
          </button>
          <p className="text-[11px] text-textMuted mt-2 leading-relaxed">
            Reset erases sessions, trash, snapshots, recovery points and settings
            from this browser and restores defaults. Your cloud account (if any)
            is not touched. Always asked for confirmation first.
          </p>
          {dataMsg && (
            <p className={`text-xs mt-2 font-medium ${dataMsg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}>
              {dataMsg.text}
            </p>
          )}
        </Section>

        {/* ═══════════ 🎨 APPEARANCE ═══════════ */}
        <Section icon={<Palette size={16} />} title="Appearance">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-textMain">Theme</p>
              <p className="text-xs text-textMuted">Switch between light, dark, or system</p>
            </div>
            <button
              onClick={onCycleTheme}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 text-sm font-medium hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
            >
              {theme === 'dark' ? '🌙 Dark' : theme === 'light' ? '☀️ Light' : '💻 System'}
            </button>
          </div>
        </Section>

        {/* ═══════════ ℹ️ ABOUT ═══════════ */}
        <Section icon={<span className="text-blue-600 dark:text-blue-400">ℹ️</span>} title="About">
          <div className="space-y-1">
            <p className="text-sm font-medium text-textMain">Orbitabs v1.2.0</p>
            <p className="text-xs text-textMuted">
              Save and restore your browser sessions instantly.
              Works offline — no account required.
            </p>
          </div>
        </Section>
      </div>

      {/* ═══════════ Confirm-gated destructive actions ═══════════ */}
      <ConfirmModal
        open={confirm?.type === 'trash'}
        title="Empty the Trash?"
        message="Every trashed session is permanently deleted. This cannot be undone."
        confirmLabel="Empty Trash"
        danger
        onConfirm={clearTrash}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm?.type === 'recovery'}
        title="Clear recovery history?"
        message="All recovery points and any queued crash recovery are erased. Your saved sessions and Live Backup are untouched."
        confirmLabel="Clear recovery data"
        danger
        onConfirm={clearRecoveryData}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm?.type === 'reset'}
        title="Reset Orbitabs?"
        message={
          `This permanently erases ALL local Orbitabs data: ` +
          `${confirm?.stats?.sessions ?? 0} saved session(s), ${confirm?.stats?.trashed ?? 0} trashed, ` +
          `${confirm?.stats?.tabs ?? 0} tabs of Live Backup state, recovery history and settings.\n\n` +
          'Export first if you want a copy. This cannot be undone.'
        }
        confirmLabel="Reset Orbitabs"
        danger
        onConfirm={resetOrbitabs}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

/* ---------------- page furniture ---------------- */

function Header({ onBack }) {
  return (
    <div className="flex items-center gap-3 mb-5 relative z-10">
      <button
        onClick={onBack}
        className="p-2 rounded-xl bg-white/80 hover:bg-white text-blue-700 dark:bg-secondary/80 dark:hover:bg-secondary dark:text-blue-300 shadow-sm transition-colors"
      >
        <ArrowLeft size={18} />
      </button>
      <h1 className="text-xl font-bold text-blue-800 dark:text-slate-100 tracking-tight">Settings</h1>
    </div>
  );
}

// Reusable Section component
function Section({ icon, title, children }) {
  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-xl p-4 border border-blue-100 dark:bg-secondary/90 dark:border-borderLight shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-blue-600 dark:text-blue-400">{icon}</span>
        <h2 className="text-sm font-bold text-blue-800 dark:text-blue-300 uppercase tracking-wide">{title}</h2>
      </div>
      {children}
    </div>
  );
}

// Setting row: label + description on the left, control on the right
function Row({ title, desc, children }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-textMain">{title}</p>
        {desc && <p className="text-[11px] text-textMuted leading-snug">{desc}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

// Two-option segmented control (scope, restore behavior)
function Segmented({ value, options, onChange }) {
  return (
    <div className="flex rounded-lg border border-blue-200 dark:border-borderLight overflow-hidden">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
            value === o.value ? 'bg-blue-600 dark:bg-blue-500 text-white' : 'bg-white dark:bg-secondary text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-muted'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Toggle switch component
function Toggle({ checked, onChange }) {
  return (
    <button
      onClick={onChange}
      className={`relative w-11 h-6 rounded-full transition-colors ${
        checked ? 'bg-blue-600 dark:bg-blue-500' : 'bg-gray-300 dark:bg-slate-600'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

// Recovery history — the live ring of snapshots with per-point restore
function RecoveryHistory({ diag, onRestore, onRefresh }) {
  if (!diag) {
    return <p className="text-xs text-textMuted italic">Open the extension in Chrome to see recovery history</p>;
  }
  return (
    <div className="mt-3 pt-3 border-t border-blue-50">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-bold text-textMuted uppercase tracking-wide">Recovery history</p>
        <button onClick={onRefresh} className="flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium">
          <RefreshCw size={11} /> Refresh
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <Stat label="Live tabs" value={diag.liveTabs} />
        <Stat label="Last save" value={diag.snapshotAgeSec != null ? `${diag.snapshotAgeSec}s ago` : 'Never'} />
      </div>
      {diag.crashQueued && (
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-2 mb-2">
          <p className="text-xs text-amber-700 dark:text-amber-300 font-medium">⚠️ Crash detected — restore available</p>
        </div>
      )}
      {diag.recoveryPoints.length > 0 ? (
        <div className="space-y-1">
          {diag.recoveryPoints.map((p, i) => {
            const mins = p.savedAt ? Math.max(0, Math.round((Date.now() - p.savedAt) / 60000)) : null;
            return (
              <div key={i} className="flex items-center justify-between bg-white/60 dark:bg-secondary/60 rounded-lg px-2 py-1.5">
                <span className="text-xs text-textMain">
                  #{i + 1} — {p.tabs} tabs, {p.windows} window{p.windows === 1 ? '' : 's'}
                  {mins != null ? ` (${mins}m ago)` : ''}
                </span>
                <button
                  onClick={() => onRestore(i)}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium"
                >
                  Restore
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[11px] text-textMuted/70 italic">No recovery points yet — they build up automatically while you browse.</p>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="bg-blue-50 dark:bg-blue-950/40 rounded-lg p-2 text-center">
      <p className="text-sm font-bold text-blue-700 dark:text-blue-300">{value}</p>
      <p className="text-[10px] text-textMuted uppercase">{label}</p>
    </div>
  );
}
