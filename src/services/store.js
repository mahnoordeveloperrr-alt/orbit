// 🆕 LOCAL-FIRST DATA LAYER (Session Snapshot v1)
// -------------------------
// Orbitabs philosophy: the browser's own storage is the source of truth.
// An account is OPTIONAL — cloud sync (services/api.js) is only used by the
// background worker's live-backup sync when the user explicitly signs in.
//
// EVERY session is persisted in the LOCKED v1 schema (services/sessionSchema.js):
//   { name, createdAt, updatedAt, windows: [{ state, focused, tabs[], groups[] }] }
// Legacy docs ({ urls, groups[].urlIndices }) are normalized on read and
// lazily upgraded to v1 whenever a doc is rewritten.
//
// Semantics mirror the backend exactly (soft delete, trash, 30-day retention)
// so the UI behaves identically online/offline. Responses are axios-shaped
// ({ data }) so components can swap api.js <-> store.js with one import change.

import { normalizeSession, SCHEMA_VERSION } from './sessionSchema';

const STORAGE_KEY = 'orbi_sessions'; // keep in sync with public/background.js
const SETTINGS_KEY = 'orbi_settings'; // 🆕 user-controlled behavior flags
// 🆕 FULL SETTINGS CONTRACT — every key here is a real behavior switch wired
// into the worker (public/background.js) or the store below. Defaults are the
// LOCAL-FIRST experience: everything on, cloud off.
const DEFAULT_SETTINGS = {
  // ⚙️ General
  autoSave: true,          // master auto-save (snapshot + Live Backup)
  autoSaveFreqSec: 30,     // 10 | 30 | 60 — heartbeat period
  defaultScope: 'all',     // save bar preselects 'all' | 'window'
  restoreBehavior: 'new',  // 'new' = new windows | 'current' = tabs in current window
  restorePinned: true,     // restore pinned tabs (and their pinned position)
  restoreActive: true,     // re-activate the saved active tab
  restoreGroups: true,     // rebuild Chrome tab groups (title/color/collapsed)
  // 💾 Backup & Recovery
  liveBackup: true,        // maintain the "Auto-save — Live Backup" session
  crashRecovery: true,     // detect crashes + offer restore + keep the ring
  maxRecoveryPoints: 5,    // recovery ring depth: 3 | 5 | 10
  trashRetentionDays: 30,  // 7 | 30 — trash auto-purge window
  // 🔐 Privacy & Data
  localOnly: false,        // hard-off switch for ALL network calls
  cloudSync: false,        // optional cloud sync (needs account + !localOnly)
};
const DAY_MS = 24 * 60 * 60 * 1000;

const hasChromeStorage = () =>
  typeof chrome !== 'undefined' && chrome.storage?.local;

const genId = () => `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/* ---------------- storage plumbing ---------------- */

async function readAll() {
  if (hasChromeStorage()) {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  }
  // Dev fallback (popup opened outside Chrome)
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

async function writeAll(sessions) {
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }
}

/** Trash retention is user-controlled (Settings → Backup & Recovery; default
 *  30 days — same as the backend rule). */
async function trashRetentionMs() {
  const s = await getSettings();
  const d = Number(s.trashRetentionDays);
  return (d > 0 ? d : 30) * DAY_MS;
}

/** Drop trash items older than the retention window (auto-purge on read). */
async function purgeExpiredTrash(sessions) {
  const retention = await trashRetentionMs();
  const expired = (s) => s.deletedAt && new Date(s.deletedAt).getTime() < Date.now() - retention;
  if (!sessions.some(expired)) return sessions;
  const kept = sessions.filter(s => !expired(s));
  await writeAll(kept);
  return kept;
}

const byNewest = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);

/** 📌 List order: pinned sessions first (AUTO Live Backup still leads — it's
 *  always newest), then newest-first within each band. */
const byPinnedThenNewest = (a, b) => (!!b.pinned - !!a.pinned) || byNewest(a, b);

/**
 * Lazy upgrade: rewrite a doc in v1 when we touch it. Keeps the store
 * clean over time without a one-time migration pass.
 */
async function upgradeDoc(raw, sessions) {
  const norm = normalizeSession(raw);
  if (!norm) return false;
  if (raw.schemaVersion === SCHEMA_VERSION && raw.windows) return false; // already v1
  const idx = sessions.findIndex(s => (s._id || s.id) === (raw._id || raw.id));
  if (idx >= 0) {
    sessions[idx] = { ...norm, _id: raw._id || raw.id || norm._id };
    await writeAll(sessions);
  }
  return true;
}

/* ---------------- public API (axios-shaped) ---------------- */

export async function getSessions() {
  const sessions = await purgeExpiredTrash(await readAll());
  const live = [];
  for (const raw of sessions.filter(s => !s.deletedAt).sort(byPinnedThenNewest)) {
    await upgradeDoc(raw, sessions); // lazy legacy → v1
    const norm = normalizeSession(raw);
    if (norm) live.push(norm);
  }
  return { data: live };
}

/**
 * Create a session. Accepts the v1 shape ({ name, windows }) — the ONLY
 * format the rest of the app should produce. Unknown/legacy args are
 * normalized defensively, but new code must pass `windows`.
 */
export async function createSession({ name, windows }) {
  const sessions = await readAll();
  const now = new Date().toISOString();
  const norm = normalizeSession({ name, windows, createdAt: now });
  if (!norm) {
    return { data: null, error: 'nothing-to-save' }; // caller decides UX
  }
  const doc = {
    ...norm,
    _id: genId(),
    isAutoSave: false,
    autoKey: null,
    deletedAt: null
  };
  await writeAll([doc, ...sessions]);
  return { data: doc };
}

/** Upsert the auto-save Live Backup (called by background.js every heartbeat). */
export async function upsertAutoSaveSession({ name, windows }) {
  const sessions = await readAll();
  const now = new Date().toISOString();
  const idx = sessions.findIndex(s => s.isAutoSave && s.autoKey === 'live-backup');
  const norm = normalizeSession({ name, windows, createdAt: now });
  if (!norm) return { data: null };

  if (idx >= 0) {
    sessions[idx] = {
      ...sessions[idx],
      name: norm.name,
      windows: norm.windows,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: now,
      createdAt: now // keep it sorted to the top of the list
    };
  } else {
    sessions.unshift({
      ...norm,
      _id: genId(),
      isAutoSave: true,
      autoKey: 'live-backup',
      deletedAt: null
    });
  }
  await writeAll(sessions);
  return { data: sessions[idx >= 0 ? idx : 0] };
}

/** Soft delete → trash (undoable for 30 days). */
export async function deleteSession(id) {
  const sessions = await readAll();
  const target = sessions.find(s => s._id === id);
  if (target) {
    target.deletedAt = new Date().toISOString();
    await writeAll(sessions);
  }
  return { data: { message: 'Session deleted (undoable)' } };
}

/** Bulk soft delete → trash (undoable). */
export async function deleteBulkSessions(ids) {
  const idSet = new Set(ids || []);
  const sessions = await readAll();
  let count = 0;
  sessions.forEach(s => {
    if (idSet.has(s._id) && !s.deletedAt) {
      s.deletedAt = new Date().toISOString();
      count++;
    }
  });
  await writeAll(sessions);
  return { data: { message: `${count} sessions deleted (undoable).`, deletedCount: count } };
}

export async function getTrash() {
  const sessions = await purgeExpiredTrash(await readAll());
  const trashed = sessions
    .filter(s => s.deletedAt)
    .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt))
    .map(normalizeSession)
    .filter(Boolean);
  return { data: trashed };
}

/** Undo single delete. */
export async function restoreSession(id) {
  const sessions = await readAll();
  const target = sessions.find(s => s._id === id);
  if (target) {
    target.deletedAt = null;
    await writeAll(sessions);
  }
  return { data: target || null };
}

/** Undo bulk delete. */
export async function restoreBulkSessions(ids) {
  const idSet = new Set(ids || []);
  const sessions = await readAll();
  let count = 0;
  sessions.forEach(s => {
    if (idSet.has(s._id) && s.deletedAt) {
      s.deletedAt = null;
      count++;
    }
  });
  await writeAll(sessions);
  return { data: { message: `${count} sessions restored.`, restoredCount: count } };
}

/** Permanently remove one trashed session (no undo). */
export async function purgeSession(id) {
  const sessions = await readAll();
  await writeAll(sessions.filter(s => !(s._id === id && s.deletedAt)));
  return { data: { message: 'Session permanently deleted' } };
}

/** Permanently empty the trash (no undo). */
export async function emptyTrash() {
  const sessions = await readAll();
  const kept = sessions.filter(s => !s.deletedAt);
  await writeAll(kept);
  return { data: { message: `${sessions.length - kept.length} sessions permanently deleted.` } };
}

/* ---------------- settings (user control — Task 14) ---------------- */

export async function getSettings() {
  // Prefer the worker as source of truth when available (it owns validation
  // + immediate alarm re-arming); fall back to direct storage elsewhere.
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (res?.ok && res.settings) return res.settings;
    } catch { /* worker asleep or absent — direct storage below */ }
  }
  if (hasChromeStorage()) {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
  }
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist a settings patch. Writes go through the worker (validation +
 *  alarm re-arm) when it can answer, else straight to storage. */
export async function setSetting(patch) {
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch });
      if (res?.ok && res.settings) return res.settings;
    } catch { /* fall through */ }
  }
  const next = { ...(await getSettings()), ...patch };
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  } else {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }
  return next;
}

/* ---------------- rename (Quick Save names are editable later) ---------------- */

/** 📌 Pin/unpin a session: pinned sessions sort above everything else in the
 *  list (the auto-save Live Backup still leads). Reversible, never destructive. */
export async function setSessionPinned(id, pinned) {
  const sessions = await readAll();
  const target = sessions.find(s => s._id === id);
  if (!target) return { data: null, error: 'not-found' };
  target.pinned = !!pinned;
  target.updatedAt = new Date().toISOString();
  await writeAll(sessions);
  return { data: target };
}

/** Rename a session (empty/whitespace name keeps the old one). */
export async function renameSession(id, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { data: null, error: 'empty-name' };
  const sessions = await readAll();
  const target = sessions.find(s => s._id === id);
  if (!target) return { data: null, error: 'not-found' };
  target.name = trimmed;
  target.updatedAt = new Date().toISOString();
  await writeAll(sessions);
  return { data: target };
}

/** Duplicate a session: same name + " (copy)", same windows, NEW id, newest. */
export async function duplicateSession(id) {
  const sessions = await readAll();
  const target = sessions.find(s => s._id === id);
  if (!target) return { data: null, error: 'not-found' };
  const now = new Date().toISOString();
  const copy = {
    ...structuredClone(target),
    _id: genId(),
    name: `${target.name || 'Session'} (copy)`,
    createdAt: now,
    updatedAt: now,
    isAutoSave: false,
    autoKey: null,
    deletedAt: null,
  };
  sessions.unshift(copy);
  await writeAll(sessions);
  return { data: copy };
}

/* ---------------- import (backup / share) ---------------- */

/**
 * Append parsed backup sessions to the local store. Assigns FRESH ids —
 * imports never collide with, overwrite, or displace existing sessions —
 * and preserves names/createdAt (falls back to the import moment when a
 * doc has no usable timestamp). Returns { imported, skipped } for the UI.
 */
export async function importSessions(parsed) {
  const incoming = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  if (incoming.length === 0) return { imported: 0, skipped: parsed?.skipped || 0, duplicates: 0 };

  const sessions = await readAll();
  const now = new Date().toISOString();
  let imported = 0, duplicates = 0;

  for (const doc of incoming) {
    const windows = Array.isArray(doc.windows) ? doc.windows : null;
    if (!windows || windows.length === 0) { continue; } // parser already skipped the truly dead ones

    // 🧬 Duplicate gate: same name AND same createdAt → already in the store.
    // Additive import means re-importing a backup would otherwise pile up copies.
    const signature = JSON.stringify([doc.name || null, doc.createdAt || null]);
    if (sessions.some(s => JSON.stringify([s.name || null, s.createdAt || null]) === signature)) {
      duplicates++;
      continue;
    }

    sessions.unshift({
      _id: genId(),                     // fresh id — no collisions, ever
      name: doc.name || 'Imported session',
      windows,
      schemaVersion: SCHEMA_VERSION,
      isAutoSave: false,
      autoKey: null,
      deletedAt: null,
      pinned: !!doc.pinned,             // 📌 survive a backup round-trip
      createdAt: doc.createdAt || now,
      updatedAt: now
    });
    imported++;
  }

  await writeAll(sessions);
  return { imported, skipped: parsed?.skipped || 0, duplicates };
}

/* ---------------- 🧹 Data Management (Settings page) ---------------- */

/** Every storage key Orbitabs owns locally. Reset removes exactly these —
 *  nothing else in the browser is ever touched. */
const ORBITABS_KEYS = [
  STORAGE_KEY, SETTINGS_KEY,
  'snapshot', 'snapshotAt', 'lastAlive', 'cleanExit', 'exitedAt',
  'recoveryPoints', 'recoveryCandidate', 'crashDetectedAt',
  'token' // the optional cloud-sync mirror — an account reset is part of a full reset
];

/** Reset Orbitabs: erase ALL local data (sessions, trash, snapshots, recovery
 *  points, settings) and restore defaults. The cloud account lives server-side
 *  and is untouched. Caller is responsible for the confirm dialog. */
export async function resetAllLocalData() {
  if (hasChromeStorage()) {
    await chrome.storage.local.remove(ORBITABS_KEYS);
  } else {
    ORBITABS_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch { /* noop */ } });
  }
  return { data: { message: 'All local Orbitabs data erased.' } };
}

/** What's currently stored — powers the Reset confirmation and gives users an
 *  honest answer to "how much of my data does this thing hold?" */
export async function getLocalDataStats() {
  const sessions = await readAll();
  const tabs = sessions.reduce(
    (n, s) => n + (s.windows || []).reduce((m, w) => m + (w.tabs?.length || 0), 0), 0
  );
  return {
    data: {
      sessions: sessions.filter(s => !s.deletedAt).length,
      trashed: sessions.filter(s => s.deletedAt).length,
      tabs
    }
  };
}
