/**
 * Orbitabs — Background Service Worker (MV3)
 * ------------------------------------------
 * AUTO-SAVE + CRASH RECOVERY architecture:
 *
 * 1. SNAPSHOT ENGINE — tabs/windows/tabGroups events (debounced) capture the full
 *    browser state into chrome.storage.session (fast) + chrome.storage.local
 *    (crash-proof). This is the live "session snapshot" in the LOCKED v1 schema
 *    (see src/services/sessionSchema.js — same shape, duplicated here because
 *    MV3 classic service workers cannot import ES modules).
 *
 * 2. PERIODIC BACKUP — chrome.alarms heartbeat every 1 min rewrites the local
 *    snapshot + Live Backup session, and every 30 min syncs it to the backend
 *    as an upserted "Auto-save" session (POST /api/sessions/autosave).
 *
 * 3. CRASH DETECTION — on graceful shutdown (last window removed) we write
 *    cleanExit:true. On next browser start, cleanExit!==true + a recent
 *    heartbeat + an existing snapshot => browser crashed => snapshot is stored
 *    as recoveryCandidate and the action badge shows "!".
 *
 * 4. RECOVERY — user restores via popup banner or notification-free badge;
 *    restoreSnapshot() rebuilds every window with tabs, groups (name/color/
 *    collapsed), pinned tabs and the active tab.
 *
 * ⚠️ MV3 RULE: every chrome.* event listener MUST be registered synchronously
 * at the top level so the sleeping worker can be woken by events.
 */

const DEFAULT_API_ORIGIN = 'http://127.0.0.1:5000'; // dev default — Settings → "Server URL" (apiBaseUrl) overrides it
// 🏢 Hosted production API (Cloudflare Worker + D1, Sites platform).
//    Baked as the Store-build default so cloud sync is zero-config:
//    a Store install must never silently target localhost (that's the dev
//    machine, not a real server). Chrome adds update_url to the manifest
//    only for Store/enterprise installs — unpacked dev loads have none, so
//    the localhost default still works locally.
//    Keep in sync with STORED_API_ORIGIN in src/services/api.js (SW can't import).
const STORED_API_ORIGIN = 'https://site-8b67ef3788b2498f88d007d22c888375.freebuff.page';
const isStoreInstalled = () => {
  try { return !!chrome.runtime?.getManifest?.().update_url; } catch { return false; }
};
const apiOrigin = (settings) => {
  const custom = String(settings?.apiBaseUrl || '').trim().replace(/\/+$/, '');
  if (custom) return custom; // explicit Server URL always wins (self-hosters)
  return isStoreInstalled() ? STORED_API_ORIGIN : DEFAULT_API_ORIGIN;
};
const LOCAL_SESSIONS_KEY = 'orbi_sessions'; // same key src/services/store.js reads/writes
const SESSION_LOCK = 'orbitabs-sessions';
async function withSessionsLock(work) {
  const locks = globalThis.navigator?.locks;
  return locks?.request
    ? locks.request(SESSION_LOCK, { mode: 'exclusive' }, work)
    : work();
}
const deepClone = (val) => (typeof structuredClone === 'function' ? structuredClone(val) : JSON.parse(JSON.stringify(val)));
const SCHEMA_VERSION = 1;
const DEBOUNCE_MS = 800;        // coalesce event bursts into one capture
const HEARTBEAT_SEC = 30;       // fallback snapshot freshness (user-configurable: Settings → Auto-save frequency)
const HEARTBEAT_MIN = HEARTBEAT_SEC / 60; // for chrome.alarms (minimum is 0.5 min)
const BACKEND_SYNC_MIN = 30;    // backend auto-save period (minutes)
const CRASH_WINDOW_MS = 12 * 60 * 60 * 1000; // a "crash" = no clean exit + a heartbeat from the last 12h.
                                             // Generous on purpose: MV3 workers are frozen for hours in
                                             // real life (long idle, OS sleep), which must NOT read as a crash.
                                             // Chrome keeps storage.local across restarts, so a stale timestamp
                                             // is the honest signal; a tight window silently DROPS recoveries.
const RECOVERY_POINTS_MAX = 10; // hard cap — Settings can lower the ring (3 | 5 | 10), never raise it past this
const RECOVERY_POINT_MIN = 1;   // minutes between recovery-ring entries (coalesces rapid bursts)

let debounceTimer = null;

/* ------------------------------------------------------------------ *
 * Settings — single source of truth: orbi_settings in storage.local,
 * written by the popup's Settings page (src/services/store.js).
 * Every key defaults ON for local-first protection; cloud is OFF.
 * ------------------------------------------------------------------ */

const SETTINGS_DEFAULTS = {
  autoSave: true,
  autoSaveFreqSec: 30,
  defaultScope: 'all',
  restoreBehavior: 'new',   // 'new' = one window per saved window | 'current' = tabs into the current window
  restorePinned: true,
  restoreActive: true,
  restoreGroups: true,
  liveBackup: true,
  crashRecovery: true,
  maxRecoveryPoints: 5,
  trashRetentionDays: 30,
  localOnly: false,
  cloudSync: false,
  apiBaseUrl: '',    // Server URL override for cloud features ('' = built-in default: hosted API for Store builds, localhost for dev)
};

async function getSettings() {
  try {
    const { orbi_settings: settings } = await chrome.storage.local.get('orbi_settings');
    return { ...SETTINGS_DEFAULTS, ...(settings || {}) };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

/** User control (Task 14): auto-save can be toggled off in Settings. */
async function autoSaveEnabled() {
  return (await getSettings()).autoSave;
}

/* ------------------------------------------------------------------ *
 * Snapshot capture — v1 schema
 * ------------------------------------------------------------------ */

/**
 * Capture the complete browser state as v1 windows[]: every window, every tab
 * (url, title, pinned, active, groupId) and every group (id, title, color,
 * collapsed). Membership = tab.groupId === group.id (scoped to the window).
 * MUST stay shape-identical to captureAllWindowsV1() in sessionSchema.js.
 */
async function captureSnapshot() {
  const wins = await chrome.windows.getAll({ populate: true });
  const windows = [];

  for (const win of wins) {
    // Real user tabs only — skip our own popup/devtools pages
    const tabs = (win.tabs || []).filter(t => {
      const u = t.url || t.pendingUrl || '';
      return u !== '' && !u.startsWith('devtools://');
    });
    if (tabs.length === 0) continue;

    // Group metadata for this window (chromeGroupId -> {title, color, collapsed})
    const groupMeta = new Map();
    if (chrome.tabGroups) {
      try {
        const groups = await chrome.tabGroups.query({ windowId: win.id });
        (groups || []).forEach(g => groupMeta.set(g.id, {
          title: g.title || '',
          color: g.color || 'grey',
          collapsed: !!g.collapsed
        }));
      } catch (e) { /* window may be gone mid-capture */ }
    }

    // Assign stable per-window group ids ("g1", "g2"…)
    const tabData = [];
    const groupsOut = [];
    const gidMap = new Map(); // chromeGroupId -> stable id

    tabs.forEach(t => {
      let groupId = null;
      if (typeof t.groupId === 'number' && t.groupId !== -1) {
        if (!gidMap.has(t.groupId)) {
          const meta = groupMeta.get(t.groupId) || {};
          const id = `g${groupsOut.length + 1}`;
          gidMap.set(t.groupId, id);
          groupsOut.push({
            id,
            title: meta.title || '',
            color: meta.color || 'grey',
            collapsed: !!meta.collapsed
          });
        }
        groupId = gidMap.get(t.groupId);
      }
      tabData.push({
        url: t.url || t.pendingUrl || '',
        title: t.title || '',
        pinned: !!t.pinned,
        active: !!t.active,
        groupId
      });
    });

    const referenced = new Set(tabData.map(t => t.groupId).filter(Boolean));

    windows.push({
      state: ['normal', 'minimized', 'maximized', 'fullscreen'].includes(win.state)
        ? win.state : 'normal',
      focused: !!win.focused,
      tabs: tabData.filter(t => t.url),
      groups: groupsOut.filter(g => referenced.has(g.id)),
      _windowId: win.id // internal parity with sessionSchema.js capture
    });
  }

  return { savedAt: Date.now(), schemaVersion: SCHEMA_VERSION, windows };
}

/** Write snapshot: session storage (fast) + local storage (crash-proof copy)
 *  + a small ring of recovery points (Task 8) so a corrupted or overwritten
 *  latest snapshot never means total loss. */
async function flushSnapshot() {
  try {
    if (!(await autoSaveEnabled())) return; // user opted out of state protection
    const snapshot = await captureSnapshot();
    await chrome.storage.session.set({ snapshot });
    await chrome.storage.local.set({ snapshot, snapshotAt: snapshot.savedAt });

    // Recovery points: spaced ≥ RECOVERY_POINT_MIN apart, newest first, ring
    // depth user-controlled (Settings → Maximum recovery points; hard cap 10).
    // The ring is part of Crash Recovery — off means no ring maintenance.
    const settings = await getSettings();
    if (!settings.crashRecovery) return;
    const { recoveryPoints = [] } = await chrome.storage.local.get('recoveryPoints');
    const newest = recoveryPoints[0];
    const ringWorthy = Array.isArray(snapshot.windows) && snapshot.windows.length > 0;
    if (ringWorthy && (!newest || snapshot.savedAt - (newest.savedAt || 0) >= RECOVERY_POINT_MIN * 60 * 1000)) {
      recoveryPoints.unshift(snapshot);
      const cap = Math.max(0, Math.min(RECOVERY_POINTS_MAX, Number(settings.maxRecoveryPoints) || 5));
      if (recoveryPoints.length > cap) recoveryPoints.length = cap;
      await chrome.storage.local.set({ recoveryPoints });
    }
  } catch (e) {
    console.error('[Orbitabs] snapshot flush failed:', e);
  }
}

/** Debounced capture — called by every tabs/windows/tabGroups event. */
function scheduleSnapshot() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushSnapshot, DEBOUNCE_MS);
}

/** Immediate capture — used when Chrome is about to close */
async function captureNow() {
  if (debounceTimer) clearTimeout(debounceTimer);
  await flushSnapshot();
}

/* ------------------------------------------------------------------ *
 * Auto-save (upsert single "Live Backup" session — local-first)
 * ------------------------------------------------------------------ */

/** v1 snapshot → Live Backup session payload (v1 `windows`). */
function snapshotToV1Session(snapshot) {
  return {
    name: 'Auto-save — Live Backup',
    windows: snapshot.windows || []
  };
}

// LOCAL-FIRST: upsert the Live Backup into chrome.storage.local so auto-save
// works with NO account. Cloud sync (below) is optional and token-gated.
async function upsertLocalLiveBackup(snapshot) {
  return withSessionsLock(async () => {
  if (!snapshot.windows.some(w => w.tabs.length > 0)) return;
  const payload = snapshotToV1Session(snapshot);
  const now = new Date().toISOString();

  const { [LOCAL_SESSIONS_KEY]: sessions } = await chrome.storage.local.get(LOCAL_SESSIONS_KEY);
  const list = Array.isArray(sessions) ? sessions : [];
  const idx = list.findIndex(s => s.isAutoSave && s.autoKey === 'live-backup');

  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      name: payload.name,
      windows: payload.windows,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: now,
      createdAt: now // keep it sorted to the top of the list
    };
  } else {
    list.unshift({
      _id: `local-${Date.now()}-auto`,
      name: payload.name,
      windows: payload.windows,
      schemaVersion: SCHEMA_VERSION,
      isAutoSave: true,
      autoKey: 'live-backup',
      deletedAt: null,
      createdAt: now
    });
  }
  await chrome.storage.local.set({ [LOCAL_SESSIONS_KEY]: list });

  });
}

// ☁️ OPTIONAL CLOUD — runs only when the user opted into cloud sync (Settings
// → Privacy & Data), has an account token (mirrored by the popup), and is not
// in Local-only mode. Local-only is the hard off-switch: no network, ever.
async function syncToBackend() {
  const settings = await getSettings();
  if (settings.localOnly) return { skipped: 'local-only' };
  if (!settings.cloudSync) return { skipped: 'cloud-sync-off' };
  if (!settings.autoSave) return { skipped: 'autosave-disabled' };
  const { token } = await chrome.storage.local.get('token');
  if (!token) return { skipped: 'not-logged-in' };

  const snapshot = await captureSnapshot();
  if (!snapshot.windows.some(w => w.tabs.length > 0)) return { skipped: 'empty' };

  const payload = snapshotToV1Session(snapshot);
  let res;
  try {
    res = await authedFetch(apiOrigin(settings), '/api/sessions/autosave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000) // never hang the worker on a dead backend
    });
  } catch (e) {
    // Local-first: a slow/dead backend is a skipped sync, not an error the
    // user sees. The next 30-min alarm retries automatically.
    return { skipped: 'backend-unreachable' };
  }
  if (!res.ok) throw new Error(`autosave sync failed: HTTP ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------------ *
 * 🔑 AUTHED FETCH — one place where a 7-day access JWT quietly turns into a
 * fresh one. On401 we try the refresh token ONCE (rotated server-side),
 * retry the original request, and only surface a real auth failure when the
 * refresh itself is dead (expired/revoked). Without this a subscriber's sync
 * would start failing at day 7 and the popup would sign them out over a
 * routine expiry. `refreshToken` is per-device and lives in storage next to
 * the token (mirrored by the popup on sign-in).
 * ------------------------------------------------------------------ */
async function refreshSession(origin) {
  try {
    const { token, refreshToken } = await chrome.storage.local.get(['token', 'refreshToken']);
    if (!token || !refreshToken) return null;
    const res = await fetch(`${origin}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    if (!data.token) return null;
    const next = { token: data.token };
    if (data.refreshToken) next.refreshToken = data.refreshToken; // rotation
    await chrome.storage.local.set(next);
    return data.token;
  } catch { return null; } // network/timeout → caller keeps the honest failure
}

async function authedFetch(origin, path, init = {}) {
  const res = await fetch(`${origin}${path}`, init);
  if (res.status !== 401) return res;
  const fresh = await refreshSession(origin);
  if (!fresh) return res; // genuinely signed out — let the401 flow through
  return fetch(`${origin}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${fresh}` },
  });
}

// ☁️☁️ FULL-LIBRARY SYNC — the second half of cloud sync. syncToBackend()
// keeps ONE Live Backup up to date; this syncs the user's SAVED sessions so a
// second device can see and restore them. Local-first rules that must never
// break (mirrors src/services/store.js + the import dedupe gate):
//   • chrome.storage.local stays the source of truth — a failed sync skips
//     and the next alarm retries; it NEVER deletes or blanks local data;
//   • additive merge with the same duplicate signature as file import
//     (name + createdAt), so re-syncing never piles up copies;
//   • per-session conflicts resolve last-write-wins on updatedAt, and the
//     server enforces the same rule — a stale client can't clobber a newer
//     server copy (PUT answers conflict:'server-newer' and we adopt it);
//   • 🔄 DELETIONS PROPAGATE (V1.6): a session trashed here is pushed as a
//     server tombstone and lands in every other device's trash; a restore
//     lifts the tombstone and un-trashes the others. Purged rows keep their
//     tombstone (30 days, same retention as trash). Tombstone application is
//     LWW too — a local edit NEWER than the delete revives instead of dying;
//   • Live Backup rides its own endpoint and is skipped here so it's never
//     duplicated as a plain session.
async function syncLibrary() {
  const settings = await getSettings();
  if (settings.localOnly) return { skipped: 'local-only' };
  if (!settings.cloudSync) return { skipped: 'cloud-sync-off' };
  const { token } = await chrome.storage.local.get('token');
  if (!token) return { skipped: 'not-logged-in' };
  const origin = apiOrigin(settings);
  if (!origin) return { skipped: 'server-not-configured' }; // defensive only — origin is always non-empty now

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const timeout = { signal: AbortSignal.timeout(15000) }; // never hang the worker
  const sig = (s) => JSON.stringify([s.name || null, s.createdAt || null]);

  // 1) PULL — cloud → local (additive, deduped by name+createdAt)
  let cloud = [];
  try {
    const res = await authedFetch(origin, '/api/sessions', { headers, ...timeout });
    if (res.status === 401) {
      // refresh already failed — the session is genuinely dead. Mirror the
      // popup's honest "Not connected" state instead of a zombie login.
      await chrome.storage.local.remove(['token', 'refreshToken']).catch(() => {});
      const status = { lastSyncAt: Date.now(), pushed: 0, updated: 0, pulled: 0, deleted: 0, restored: 0, lastError: 'auth-expired' };
      await chrome.storage.local.set({ orbi_sync_status: status }).catch(() => {});
      return { skipped: 'auth-expired' };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cloud = await res.json();
    if (!Array.isArray(cloud)) cloud = [];
  } catch (e) {
    const status = { lastSyncAt: Date.now(), pushed: 0, updated: 0, pulled: 0, deleted: 0, restored: 0, lastError: 'backend-unreachable' };
    await chrome.storage.local.set({ orbi_sync_status: status }).catch(() => {});
    return { skipped: 'backend-unreachable' };
  }

  // 1b) PULL tombstones — 🔄 which ids the cloud says are deleted (trashed
  //     OR purged). Best-effort: an older self-hosted server without the
  //     endpoint (404) simply has nothing to propagate, and a hiccup here
  //     never blocks the live-list merge — next alarm retries.
  let tombstones = [];
  let syncWarnings = 0;
  try {
    const res = await authedFetch(origin, '/api/sessions/tombstones', { headers, ...timeout });
    if (res.ok) {
      const arr = await res.json().catch(() => []);
      if (Array.isArray(arr)) tombstones = arr;
    }
  } catch { /* best-effort — see above */ }

  const { [LOCAL_SESSIONS_KEY]: raw } = await chrome.storage.local.get(LOCAL_SESSIONS_KEY);
  const originalLocal = Array.isArray(raw) ? deepClone(raw) : [];
  const local = deepClone(originalLocal);
  const have = new Set(local.filter(s => !s.isAutoSave).map(sig));
  // Identity by cloudId too: a doc we already own locally (even under a new
  // name after a rename) must never be re-pulled as a duplicate copy.
  const haveCloudIds = new Set(local.map(s => s.cloudId).filter(Boolean).map(String));

  // 1c) 🔄 APPLY DELETIONS / RESTORES from the cloud — runs BEFORE the
  //     additive pull so a remotely deleted session never re-arrives as a
  //     fresh copy. Both directions are last-write-wins:
  //       • tombstone newer than the local copy  → move it to local trash;
  //       • server copy live again (restored) and newer than our delete →
  //         un-trash it here too (restore bumps updatedAt server-side).
  let deleted = 0, restored = 0;
  const tombBy = new Map(tombstones.filter(t => t && t._id).map(t => [String(t._id), t]));
  for (const s of local) {
    if (!s.cloudId || s.isAutoSave) continue;
    const t = tombBy.get(String(s.cloudId));
    if (t && !s.deletedAt) {
      const localAt = new Date(s.updatedAt || s.createdAt || 0).getTime();
      const delAt = new Date(t.deletedAt || 0).getTime();
      if (localAt <= delAt) { // a NEWER local edit revives instead (push phase)
        s.deletedAt = t.deletedAt || new Date().toISOString();
        deleted++;
      }
    } else if (!t && s.deletedAt) {
      const doc = cloud.find(c => String(c._id) === String(s.cloudId));
      const cloudAt = doc ? new Date(doc.updatedAt || doc.createdAt || 0).getTime() : 0;
      if (doc && cloudAt > new Date(s.deletedAt).getTime()) {
        s.deletedAt = null;
        if (doc.updatedAt) s.updatedAt = doc.updatedAt; // adopt → no churn next sync
        restored++;
      }
    }
  }
  let pulled = 0;
  for (const doc of cloud) {
    if (doc?.isAutoSave) continue; // live backup has its own upsert path
    if (!Array.isArray(doc?.windows) || doc.windows.length === 0) continue;
    if (doc._id && haveCloudIds.has(String(doc._id))) continue; // already ours
    if (have.has(sig(doc))) continue;
    local.unshift({
      _id: `local-cloud-${Date.now()}-${pulled}`,
      name: doc.name || 'Cloud session',
      windows: doc.windows,
      schemaVersion: SCHEMA_VERSION,
      isAutoSave: false,
      autoKey: null,
      deletedAt: null,
      pinned: !!doc.pinned,
      // 🆕 V1.5 metadata rides the same pull path (same sanitize contract as
      //    the server normalizer + popup normalizeSession)
      tags: Array.isArray(doc.tags) ? doc.tags.filter(t => typeof t === 'string' && t.trim()).slice(0, 20) : [],
      note: typeof doc.note === 'string' ? doc.note : '',
      folder: (typeof doc.folder === 'string' && doc.folder.trim()) ? doc.folder.trim() : null,
      createdAt: doc.createdAt || new Date().toISOString(),
      updatedAt: doc.updatedAt || new Date().toISOString(),
      cloudId: doc._id || null // remember for future updates
    });
    have.add(sig(doc));
    pulled++;
  }

  // 2) PUSH — local → cloud (create unknown, update diverged, adopt newer)
  let pushed = 0, updated = 0, failedSessions = syncWarnings;
  let quotaHit = false; // server said the free plan's sync cap is reached
  // Shared create path — used for brand-new sessions AND for the edge where
  // our row vanished server-side (purged by the other device) while our copy
  // is the newer write: the tombstoned id stays deleted, the edit is saved
  // under a fresh id instead of being lost to an endless 404.
  const createOnCloud = async (s) => {
    const res = await authedFetch(origin, '/api/sessions', {
      method: 'POST', headers, ...timeout,
      // createdAt travels with the doc so the signature (name+createdAt)
      // matches on every future sync — otherwise the server stamps its own
      // time and this device would re-pull its own sessions as duplicates.
      // 🆕 V1.5: tags/note/folder travel too, so a tagged session keeps its
      //    organization on the server (and every other device).
      body: JSON.stringify({
        name: s.name, windows: s.windows, createdAt: s.createdAt, updatedAt: s.updatedAt,
        tags: s.tags || [], note: s.note || '', folder: s.folder ?? null
      })
    });
    if (res.ok) {
      const doc = await res.json().catch(() => ({}));
      s.cloudId = doc._id || null;
      // Adopt the server's authoritative stamp so the NEXT sync sees
      // localAt === cloudAt (no perpetual spurious "update" churn).
      if (doc.updatedAt) s.updatedAt = doc.updatedAt;
      pushed++;
      return true;
    }
    if (res.status === 402) quotaHit = true; // surfaced as status.lastError
    failedSessions++;
    return false;
  };
  const live = local.filter(s => !s.isAutoSave && !s.deletedAt && Array.isArray(s.windows) && s.windows.length > 0);
  const cloudBySig = new Map(cloud.filter(s => !s.isAutoSave).map(s => [sig(s), s]));
  for (const s of live) {
    if (quotaHit) break; // no point hammering an honest402 with more creates
    let match = (s.cloudId && cloud.find(c => String(c._id) === String(s.cloudId))) || cloudBySig.get(sig(s)) || null;
    // 🔄 Restored locally while the server still holds a tombstone → lift it.
    //     If our edit is NEWER than the delete we fall into the PUT path with
    //     a synthetic match instead (server revives on the newer stamp).
    if (!match && s.cloudId && tombBy.has(String(s.cloudId))) {
      const t = tombBy.get(String(s.cloudId));
      const localAt = new Date(s.updatedAt || s.createdAt || 0).getTime();
      const delAt = new Date(t.deletedAt || 0).getTime();
      if (localAt > delAt) {
        match = { _id: s.cloudId, updatedAt: t.deletedAt }; // synthetic → PUT revives
      } else {
        const res = await authedFetch(origin, `/api/sessions/${s.cloudId}/restore`, {
          method: 'POST', headers, ...timeout,
        });
        if (res.ok) {
          match = await res.json().catch(() => null);
          tombBy.delete(String(s.cloudId));
          restored++;
        } else {
          failedSessions++;
          continue; // refused → keep local state, next sync retries honestly
        }
      }
    }
    try {
      if (!match) {
        await createOnCloud(s);
      } else {
        s.cloudId = match._id || s.cloudId;
        const localAt = new Date(s.updatedAt || s.createdAt || 0).getTime();
        const cloudAt = new Date(match.updatedAt || match.createdAt || 0).getTime();
        if (localAt > cloudAt) {
          const res = await authedFetch(origin, `/api/sessions/${match._id}`, {
            method: 'PUT', headers, ...timeout,
            body: JSON.stringify({
              name: s.name, windows: s.windows, updatedAt: s.updatedAt,
              tags: s.tags || [], note: s.note || '', folder: s.folder ?? null
            })
          });
          if (!res.ok && res.status !== 404) failedSessions++;
          if (res.ok) {
            const body = await res.json().catch(() => ({}));
            if (body?.conflict === 'server-newer' && body.session) {
              // Server copy is newer — take it (LWW the other way).
              s.name = body.session.name || s.name;
              s.windows = body.session.windows || s.windows;
              s.updatedAt = body.session.updatedAt || s.updatedAt;
              // 🆕 V1.5 metadata adopted with the same LWW branch
              if (Array.isArray(body.session.tags)) s.tags = body.session.tags;
              if (typeof body.session.note === 'string') s.note = body.session.note;
              if (body.session.folder !== undefined) s.folder = body.session.folder;
              // 🔄 The newer server copy may BE a delete (soft-delete bumps
              //     updated_at) — adopt the trash state too, honestly.
              if (body.session.deletedAt && !s.deletedAt) {
                s.deletedAt = body.session.deletedAt;
                deleted++;
              }
            } else {
              // Adopt the server's post-write stamp (same anti-churn rule as POST).
              if (body.updatedAt) s.updatedAt = body.updatedAt;
              updated++;
            }
          } else if (res.status === 404) {
            // Row vanished (purged elsewhere) while our copy was the newer
            // write → save the edit under a fresh id; the old id's tombstone
            // keeps every other device's copy in the trash where it belongs.
            await createOnCloud(s);
          }
        } else if (cloudAt > localAt) {
          // Cloud copy is newer — adopt it locally.
          s.name = match.name || s.name;
          s.windows = match.windows || s.windows;
          s.updatedAt = match.updatedAt || s.updatedAt;
          // 🆕 V1.5 metadata adopted with the same LWW branch
          if (Array.isArray(match.tags)) s.tags = match.tags;
          if (typeof match.note === 'string') s.note = match.note;
          if (match.folder !== undefined) s.folder = match.folder;
          updated++;
        }
      }
    } catch (e) { failedSessions++; /* keep going; report partial sync honestly */ }
  }

  // 2b) 🔄 PROPAGATE LOCAL DELETES — a session we trashed that the cloud
  //     still serves live → DELETE it there (server keeps a tombstone so
  //     every other device trashes its copy on their next sync). Skip when a
  //     tombstone already exists: it's already deleted on the server.
  for (const s of local) {
    if (!s.cloudId || s.isAutoSave || !s.deletedAt) continue;
    if (tombBy.has(String(s.cloudId))) continue; // already deleted there
    if (!cloud.some(c => String(c._id) === String(s.cloudId))) continue; // never pushed
    try {
      const res = await authedFetch(origin, `/api/sessions/${s.cloudId}`, {
        method: 'DELETE', headers, ...timeout,
      });
      if (res.ok) {
        tombBy.set(String(s.cloudId), { _id: s.cloudId, deletedAt: s.deletedAt });
        deleted++;
      } else {
        failedSessions++;
      }
    } catch { failedSessions++; /* retried next alarm */ }

  }

  // 3) Commit under the same cross-context lock as popup writes. Merge any
  //    local changes made while network requests were in flight, and abort
  //    if the user signed out, reset data, or turned sync off meanwhile.
  const committed = await withSessionsLock(async () => {
    const latestData = await chrome.storage.local.get([LOCAL_SESSIONS_KEY, 'token', 'orbi_settings']);
    if (!latestData.token || !latestData.orbi_settings?.cloudSync || latestData.orbi_settings?.localOnly) return false;
    const latest = Array.isArray(latestData[LOCAL_SESSIONS_KEY]) ? latestData[LOCAL_SESSIONS_KEY] : [];
    const keyOf = (s) => String(s?._id || s?.id || s?.cloudId || '');
    const originalById = new Map(originalLocal.map(s => [keyOf(s), s]).filter(([id]) => id));
    const latestById = new Map(latest.map(s => [keyOf(s), s]).filter(([id]) => id));
    const merged = new Map(local.map(s => [keyOf(s), s]).filter(([id]) => id));
    for (const [id, original] of originalById) {
      const current = latestById.get(id);
      if (!current) {
        for (const [candidateId, candidate] of merged) {
          if (candidateId === id || (original.cloudId && String(candidate.cloudId) === String(original.cloudId))) merged.delete(candidateId);
        }
      } else if (JSON.stringify(current) !== JSON.stringify(original)) {
        merged.set(id, current); // newer local save, rename, metadata, trash, or restore wins
      }
    }
    for (const [id, current] of latestById) {
      if (!originalById.has(id) && !merged.has(id)) merged.set(id, current); // new local sessions survive
    }
    await chrome.storage.local.set({ [LOCAL_SESSIONS_KEY]: [...merged.values()] });
    return true;
  });
  if (!committed) return { pushed, updated, pulled: 0, deleted: 0, restored: 0, skipped: 'sync-disabled-or-signed-out' };
  const status = {
    lastSyncAt: Date.now(), pushed, updated, pulled, deleted, restored,
    lastError: quotaHit ? 'quota-exceeded' : failedSessions ? 'partial-sync' : null,
  };
  await chrome.storage.local.set({ orbi_sync_status: status });
  return { pushed, updated, pulled, deleted, restored, failedSessions, lastError: status.lastError };
}

/* ------------------------------------------------------------------ *
 * Restore — v1 windows[] → real browser state
 * ------------------------------------------------------------------ */

/**
 * Rebuild browser state from a v1 snapshot.
 *
 * Behavior is driven by Settings (restoreBehavior / restorePinned /
 * restoreActive / restoreGroups) with per-call overrides via `options`.
 *  - behavior 'new'     → one window per saved window (default)
 *  - behavior 'current' → all tabs open in the current window, saved order
 * One window per saved window, tabs in order, then groups (id matching,
 * title/color/collapsed), then pinned tabs, the active tab, and window state.
 * The saved focused window gets focus at the very end.
 */
async function restoreSnapshot(snapshot, options = {}) {
  const s = await getSettings();
  const o = {
    behavior: s.restoreBehavior === 'current' ? 'current' : 'new',
    pinned: s.restorePinned !== false,
    active: s.restoreActive !== false,
    groups: s.restoreGroups !== false,
    ...options, // per-call overrides win
  };
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  let restoredWindows = 0;
  let restoredTabs = 0;
  const createdIds = [];

  // ── Restore into the CURRENT window ────────────────────────────────
  if (o.behavior === 'current') {
    try {
      const cur = chrome.windows.getCurrent ? await chrome.windows.getCurrent() : null;
      const savedTabs = windows.flatMap((win, sourceWindowIndex) =>
        (win.tabs || []).filter(t => t.url).map(tab => ({ tab, sourceWindowIndex, sourceFocused: !!win.focused }))
      );
      const createdTabs = [];
      for (const entry of savedTabs) {
        const { tab, sourceFocused } = entry;
        try {
          const created = await chrome.tabs.create({
            url: tab.url,
            ...(cur?.id ? { windowId: cur.id } : {}),
            active: !!(o.active && sourceFocused && tab.active),
            ...(o.pinned && tab.pinned ? { pinned: true } : {})
          });
          if (created?.id != null) {
            createdTabs.push({ ...entry, id: created.id });
            restoredTabs++;
          }
        } catch (e) { /* invalid or restricted URL � keep restoring the rest */ }
      }
      if (o.groups && chrome.tabs.group && cur?.id) {
        for (let sourceWindowIndex = 0; sourceWindowIndex < windows.length; sourceWindowIndex++) {
          const win = windows[sourceWindowIndex];
          for (const group of win.groups || []) {
            const ids = createdTabs
              .filter(entry => entry.sourceWindowIndex === sourceWindowIndex && entry.tab.groupId === group.id)
              .map(entry => entry.id);
            if (!ids.length) continue;
            try {
              const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: cur.id } });
              const props = {};
              if (group.title) props.title = group.title;
              if (group.color) props.color = group.color;
              if (Object.keys(props).length) await chrome.tabGroups.update(groupId, props);
              if (group.collapsed) await chrome.tabGroups.update(groupId, { collapsed: true });
            } catch (e) { console.error('[Orbitabs] group restore failed in current window:', e); }
          }
        }
      }
      restoredWindows = createdTabs.length ? 1 : 0;
      return { restoredWindows, restoredTabs, behavior: 'current' };
    } catch (e) {
      console.error('[Orbitabs] current-window restore failed, falling back to new windows:', e);
    }
  }

  for (const win of windows) {
    const savedTabs = (win.tabs || []).filter(t => t.url);
    if (savedTabs.length === 0) continue;

    let created;
    try {
      created = await chrome.windows.create({ url: savedTabs.map(t => t.url), focused: false });
    } catch (e) {
      // 🆕 Graceful degradation (Task 3): window creation failed (often ONE bad
      // URL) — open the tabs individually instead of losing the whole window.
      console.error('[Orbitabs] window restore failed, falling back per-tab:', e);
      for (const t of savedTabs) {
        try {
          await chrome.tabs.create({ url: t.url });
          restoredTabs++;
        } catch (e2) { /* dead URL — skip it, keep the rest */ }
      }
      continue;
    }
    restoredWindows++;
    createdIds.push(created.id);
    restoredTabs += savedTabs.length;
    const tabIds = (created.tabs || []).map(t => t.id);

    // 1. Groups first (grouping doesn't reorder tabs). Membership is resolved
    //    by groupId matching — immune to pin reordering later.
    if (o.groups && chrome.tabs.group && (win.groups || []).length > 0) {
      for (const g of win.groups) {
        try {
          const ids = (win.tabs || [])
            .map((t, i) => (t.groupId === g.id ? tabIds[i] : null))
            .filter(Boolean);
          if (ids.length === 0) continue;
          const groupId = await chrome.tabs.group({
            tabIds: ids,
            createProperties: { windowId: created.id }
          });
          const props = {};
          if (g.title) props.title = g.title;
          if (g.color) props.color = g.color;
          if (Object.keys(props).length > 0) await chrome.tabGroups.update(groupId, props);
          if (g.collapsed) await chrome.tabGroups.update(groupId, { collapsed: true });
        } catch (e) {
          console.error('[Orbitabs] group restore failed for one group:', e);
        }
      }
    }

    // 2. Pinned tabs + active tab (by tab id — immune to pin reordering)
    for (let i = 0; i < win.tabs.length && i < tabIds.length; i++) {
      try {
        if (o.pinned && win.tabs[i].pinned) await chrome.tabs.update(tabIds[i], { pinned: true });
        if (o.active && win.tabs[i].active) await chrome.tabs.update(tabIds[i], { active: true });
      } catch (e) { /* tab may be gone */ }
    }

    // 3. Window state (maximized/minimized/fullscreen)
    if (win.state && win.state !== 'normal') {
      try { await chrome.windows.update(created.id, { state: win.state }); } catch (e) { /* ignore */ }
    }
  }

  // 4. Focus the saved focused window (if it still exists)
  const focusedWin = windows.find(w => w.focused);
  if (focusedWin) {
    const ordinal = windows.filter(w => w.tabs?.length > 0).indexOf(focusedWin);
    const targetId = createdIds[ordinal];
    if (targetId) {
      try { await chrome.windows.update(targetId, { focused: true }); } catch (e) { /* ignore */ }
    }
  }

  return { restoredWindows, restoredTabs };
}

/** LEGACY pre-v1 doc ({ urls[], groups[].urlIndices }) → v1 windows[] as ONE
 *  window — the worker's mirror of popup sessionSchema.legacyToV1. The hotkey
 *  must work even before the popup has ever lazily upgraded the doc, otherwise
 *  Alt+Shift+R on an old-format save silently restores nothing. Pure: no mutation. */
function legacySessionToWindows(doc) {
  const urls = (Array.isArray(doc?.urls) ? doc.urls : [])
    .map(u => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean);
  if (urls.length === 0) return [];
  const legacyGroups = Array.isArray(doc.groups) ? doc.groups : [];
  const groupsOut = [];
  const gidByIndex = new Map(); // legacy group index → synthetic v1 id
  const tabs = urls.map((url, i) => {
    const gi = legacyGroups.findIndex(g => g && Array.isArray(g.urlIndices) && g.urlIndices.includes(i));
    let groupId = null;
    if (gi >= 0) {
      if (!gidByIndex.has(gi)) {
        const id = `g${gi + 1}`;
        gidByIndex.set(gi, id);
        groupsOut.push({
          id,
          title: String(legacyGroups[gi].title || ''),
          color: legacyGroups[gi].color || 'grey',
          collapsed: !!legacyGroups[gi].collapsed
        });
      }
      groupId = gidByIndex.get(gi);
    }
    return { url, title: '', pinned: false, active: false, groupId };
  });
  return [{ state: 'normal', focused: true, tabs, groups: groupsOut }];
}

/* ------------------------------------------------------------------ *
 * Crash detection + recovery
 * ------------------------------------------------------------------ */

async function markCrashAndQueueRecovery(snapshot) {
  // Trust guard: never queue a candidate that would "restore" into an empty
  // browser. An empty snapshot here means capture raced the crash or the
  // state was genuinely blank — offering recovery would be a lie.
  const tabCount = (snapshot?.windows || []).reduce((n, w) => n + (w.tabs?.length || 0), 0);
  if (tabCount === 0) {
    console.warn('[Orbitabs] crash candidate had 0 tabs — not queuing an empty recovery');
    return false;
  }
  await chrome.storage.local.set({
    recoveryCandidate: snapshot,
    crashDetectedAt: Date.now()
  });
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  chrome.action.setTitle({ title: 'Orbitabs — Chrome crashed! Click to restore your session.' });
  return true;
}

async function clearRecoveryState() {
  await chrome.storage.local.remove(['recoveryCandidate', 'crashDetectedAt']);
  chrome.action.setBadgeText({ text: '' });
}

/* ------------------------------------------------------------------ *
 * Quick Save — LOCAL-FIRST (keyboard: Alt+Shift+S)
 * ------------------------------------------------------------------ */

/** Same local upsert as the Live Backup, but as a NAMED session so it never
 *  gets overwritten by the auto-save worker. Counted tabs land in the name. */
async function quickSaveLocally() {
  return withSessionsLock(async () => {
  // NOTE: deliberately NOT gated on autoSaveEnabled() — that setting controls
  // the passive Live Backup, not an explicit user action. The keyboard
  // shortcut and popup must never silently drop a requested save.
  const snapshot = await captureSnapshot();
  const tabCount = snapshot.windows.reduce((n, w) => n + w.tabs.length, 0);
  if (tabCount === 0) return { skipped: 'empty' };

  const payload = snapshotToV1Session(snapshot);
  const now = new Date().toISOString();
  const name = `Quick Save — ${new Date().toLocaleString()} (${tabCount} tab${tabCount === 1 ? '' : 's'})`;

  const { [LOCAL_SESSIONS_KEY]: sessions } = await chrome.storage.local.get(LOCAL_SESSIONS_KEY);
  const list = Array.isArray(sessions) ? sessions : [];
  list.unshift({
    _id: `local-${Date.now()}-quick`,
    name,
    windows: payload.windows,
    schemaVersion: SCHEMA_VERSION,
    isAutoSave: false,
    autoKey: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now
  });
  await chrome.storage.local.set({ [LOCAL_SESSIONS_KEY]: list });
  return { ok: true, windows: snapshot.windows.length, tabs: tabCount };

  });
}

/* ------------------------------------------------------------------ *
 * Alarms (periodic backup)
 * ------------------------------------------------------------------ */

/** Ensure the heartbeat + sync alarms exist, with the heartbeat period taken
 *  from Settings (Auto-save frequency: 10 | 30 | 60 sec — floor 30s, Chrome's
 *  alarm minimum is 0.5 min). Existing alarms are recreated when the period
 *  changes, so the setting takes effect without waiting for a restart. */
async function ensureAlarms(freqSec) {
  const period = Math.max(HEARTBEAT_MIN, (Number(freqSec) || HEARTBEAT_SEC) / 60);
  const existing = await chrome.alarms.getAll();
  const byName = new Map(existing.map(a => [a.name, a]));
  if (!byName.has('orbi-heartbeat') || Math.abs(byName.get('orbi-heartbeat').periodInMinutes - period) > 0.01) {
    chrome.alarms.clear('orbi-heartbeat');
    chrome.alarms.create('orbi-heartbeat', { periodInMinutes: period });
  }
  if (!byName.has('orbi-autosave-sync')) {
    chrome.alarms.create('orbi-autosave-sync', { periodInMinutes: BACKEND_SYNC_MIN });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'orbi-heartbeat') {
    // Keep-alive marker for crash detection + crash-proof snapshot refresh.
    // (flushSnapshot itself is gated by the auto-save setting.)
    flushSnapshot();
    chrome.storage.local.set({ lastAlive: Date.now() });
    // LOCAL-FIRST: Live Backup session is maintained locally every heartbeat,
    // no account required — only when the user hasn't turned it off.
    getSettings()
      .then(s => (s.autoSave && s.liveBackup)
        ? captureSnapshot().then(snap => upsertLocalLiveBackup(snap))
        : null)
      .catch(e => console.error('[Orbitabs] local live-backup:', e));
  } else if (alarm.name === 'orbi-autosave-sync') {
    syncToBackend().catch(e => console.error('[Orbitabs] backend autosave:', e));
    // ☁️ Full-library sync rides the same 30-min cadence (opt-in, same gates).
    syncLibrary().catch(e => console.error('[Orbitabs] library sync:', e));
  }
});

/* ------------------------------------------------------------------ *
 * Keyboard commands (manifest commands — user-remappable at
 * chrome://extensions/shortcuts). Registered at top level per MV3 rules.
 * ------------------------------------------------------------------ */

chrome.commands?.onCommand?.addListener((command) => {
  if (command === 'quick-save') {
    quickSaveLocally()
      .then(r => {
        // Silent success (badge pulse); only surface errors to the user.
        if (r && r.skipped) return;
        chrome.action.setBadgeText({ text: '✓' });
        chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
        setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1200);
      })
      .catch(e => {
        console.error('[Orbitabs] quick-save command failed:', e);
        chrome.action.setBadgeText({ text: '✗' });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
        setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
      });
  }

  if (command === 'restore-last') {
    (async () => {
      const { [LOCAL_SESSIONS_KEY]: sessions } = await chrome.storage.local.get(LOCAL_SESSIONS_KEY);
      const list = Array.isArray(sessions) ? sessions : [];
      const alive = list.filter(s => !s.deletedAt);
      // Restorable = v1 windows[] with content, OR a pre-v1 urls[] doc.
      const restorable = (s) =>
        (Array.isArray(s?.windows) && s.windows.length > 0) ||
        (Array.isArray(s?.urls) && s.urls.length > 0);

      // ⚠️ THE AUTO-SAVE LIVE BACKUP IS ALWAYS "NEWEST": the heartbeat re-stamps
      //    its createdAt every ~30s (upsertLocalLiveBackup), so a plain
      //    newest-first pick restored the CURRENT browser state — the hotkey
      //    looked dead (it duplicated open tabs) and never reopened what
      //    Alt+Shift+S had just saved. Prefer the user's own saves
      //    (isAutoSave=false — Quick Save, popup saves); the Live Backup is
      //    only the fallback when nothing else exists (still useful seconds
      //    after closing windows, before the next heartbeat overwrites it).
      const manual = alive.filter(s => !s.isAutoSave && restorable(s));
      const pool = manual.length > 0 ? manual : alive.filter(restorable);
      const newest = pool.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      if (!newest) return; // nothing saved yet — stay silent

      const windows = (Array.isArray(newest.windows) && newest.windows.length > 0)
        ? newest.windows
        : legacySessionToWindows(newest);

      const r = await restoreSnapshot({ windows });
      // Nothing actually opened (corrupt doc / every URL dead) → stay silent,
      // same as "nothing saved yet". Otherwise pulse the SAME green ✓ as
      // quick-save so the hotkey gives visible feedback (TEST_PLAN Test L).
      if (!r || !(r.restoredTabs > 0)) return;
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1200);
    })().catch(e => {
      console.error('[Orbitabs] restore-last command failed:', e);
      chrome.action.setBadgeText({ text: '✗' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
    });
  }
});

/* ------------------------------------------------------------------ *
 * Tab / window / group events — all top-level (MV3 requirement)
 * ------------------------------------------------------------------ */

chrome.tabs.onCreated.addListener(scheduleSnapshot);
chrome.tabs.onRemoved.addListener(scheduleSnapshot);
chrome.tabs.onMoved.addListener(scheduleSnapshot);
chrome.tabs.onAttached.addListener(scheduleSnapshot);
chrome.tabs.onDetached.addListener(scheduleSnapshot);
chrome.tabs.onReplaced.addListener(scheduleSnapshot);

// onUpdated fires constantly — only react to changes that affect the snapshot
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const relevant = changeInfo.url || changeInfo.title || 'pinned' in changeInfo ||
    'groupId' in changeInfo || changeInfo.status === 'complete';
  if (relevant) scheduleSnapshot();
});

chrome.windows.onCreated.addListener(scheduleSnapshot);

chrome.windows.onRemoved.addListener(async () => {
  const wins = await chrome.windows.getAll({});
  if (wins.length === 0) {
    // Last window closed = graceful browser shutdown.
    // ⚠️ Do NOT re-capture here — tabs are already gone; keep the last snapshot.
    // The frequent heartbeat (every 30 sec) ensures we have a recent snapshot.
    await chrome.storage.local.set({ cleanExit: true, exitedAt: Date.now() });
  } else {
    // Window closed but others remain — capture immediately for crash safety
    await captureNow();
  }
});

// Group rename / recolor / collapse changes also affect the snapshot
if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener(scheduleSnapshot);
  chrome.tabGroups.onUpdated.addListener(scheduleSnapshot);
  chrome.tabGroups.onRemoved.addListener(scheduleSnapshot);
}

/* ------------------------------------------------------------------ *
 * Lifecycle: install, browser start, messages
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ cleanExit: false, lastAlive: Date.now() });
  await ensureAlarms();
  flushSnapshot();
});

chrome.runtime.onStartup.addListener(async () => {
  // Observability: a 'entered' phase proves the listener RAN; final write
  // records WHY the check decided what it decided — the only way to tell
  // "detection ran and said no" from "detection never ran" (QA/support).
  const startedAt = Date.now();
  const setDiag = (v) => chrome.storage.local.set({ lastStartupCheck: v }).catch(() => {});
  await setDiag({ at: startedAt, phase: 'entered' });
  try {
    const settings = await getSettings();
    await ensureAlarms(settings.autoSaveFreqSec);

    const { snapshot, cleanExit, lastAlive } = await chrome.storage.local.get(
      ['snapshot', 'cleanExit', 'lastAlive']
    );

    const heartbeatFresh = lastAlive && (Date.now() - lastAlive) < CRASH_WINDOW_MS;
    // Crash detection honors the Crash Recovery switch: OFF = never interrupt
    // the user with a recovery offer (and the badge stays quiet).
    const crashed = settings.crashRecovery &&
      cleanExit !== true && !!snapshot && !!heartbeatFresh && snapshot.windows?.length > 0;

    if (crashed) {
      await markCrashAndQueueRecovery(snapshot);
    }

    await setDiag({
      at: startedAt,
      phase: 'done',
      crashed: !!crashed,
      reasons: {
        crashRecovery: !!settings.crashRecovery,
        cleanExitWasTrue: cleanExit === true,
        hasSnapshot: !!snapshot,
        snapshotWindows: (snapshot?.windows || []).length,
        heartbeatFresh: !!heartbeatFresh,
        lastAliveAgeMs: lastAlive ? Date.now() - lastAlive : null,
      },
    });

    // Mark "running" for the next exit-crash comparison
    await chrome.storage.local.set({ cleanExit: false, lastAlive: Date.now() });
    flushSnapshot();
  } catch (e) {
    await setDiag({ at: startedAt, phase: 'error', error: String(e) });
    console.error('[Orbitabs] onStartup crash check failed:', e);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'RESTORE_RECOVERY') {
    (async () => {
      try {
        const { recoveryCandidate } = await chrome.storage.local.get('recoveryCandidate');
        if (!recoveryCandidate) return sendResponse({ ok: false, error: 'no-recovery-candidate' });
        const result = await restoreSnapshot(recoveryCandidate);
        await clearRecoveryState();
        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error('[Orbitabs] recovery restore failed:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // async sendResponse
  }

  if (msg?.type === 'DISMISS_RECOVERY') {
    clearRecoveryState().then(() => sendResponse({ ok: true }));
    return true;
  }

  // 🆕 UNIFIED RESTORE — popup sends a v1 session (any saved session); the
  // worker has the full multi-window restore logic.
  if (msg?.type === 'RESTORE_SESSION') {
    (async () => {
      try {
        const result = await restoreSnapshot(msg.session);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error('[Orbitabs] session restore failed:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  // 🆕 RECOVERY POINT — restore from a HISTORICAL snapshot (ring buffer),
  // e.g. when the latest snapshot is corrupted/overwritten or you want the
  // state from a few minutes ago. Additive: only opens new windows.
  if (msg?.type === 'RESTORE_RECOVERY_POINT') {
    (async () => {
      try {
        const { recoveryPoints = [] } = await chrome.storage.local.get('recoveryPoints');
        const idx = Number(msg.index);
        const point = Number.isInteger(idx) ? recoveryPoints[idx] : null;
        if (!point || !Array.isArray(point.windows)) {
          return sendResponse({ ok: false, error: 'no-such-recovery-point' });
        }
        const result = await restoreSnapshot(point);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error('[Orbitabs] recovery-point restore failed:', e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === 'SNAPSHOT_NOW') {
    flushSnapshot().then(() => sendResponse({ ok: true }));
    return true;
  }

  // 🆕 Settings — the worker is the read/write source of truth for the popup.
  // GET returns the full merged settings object; SET validates the patch and
  // reapplies the heartbeat period immediately (frequency change needs no
  // browser restart).
  if (msg?.type === 'GET_SETTINGS') {
    getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (msg?.type === 'SET_SETTINGS') {
    (async () => {
      const patch = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
      const next = { ...(await getSettings()), ...patch };
      // Hard invariants: local-only forces cloud off; cloud needs a token later
      // (checked at sync time); ring cap and alarm floor are enforced here.
      if (next.localOnly) next.cloudSync = false;
      next.maxRecoveryPoints = Math.max(1, Math.min(RECOVERY_POINTS_MAX, Number(next.maxRecoveryPoints) || 5));
      next.autoSaveFreqSec = Math.max(30, Number(next.autoSaveFreqSec) || 30);
      next.trashRetentionDays = [7, 30].includes(next.trashRetentionDays) ? next.trashRetentionDays : 30;
      await chrome.storage.local.set({ orbi_settings: next });
      if (patch.autoSaveFreqSec !== undefined) await ensureAlarms(next.autoSaveFreqSec);
      sendResponse({ ok: true, settings: next });
    })().catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg?.type === 'SYNC_NOW') {
    (async () => {
      try {
        // Both halves: the Live Backup snapshot AND the saved-session library.
        // The legacy result.skipped contract (settings/reliability suites) is
        // preserved — backup's outcome stays top-level, library nests under it.
        const backup = await syncToBackend();
        let library;
        try { library = await syncLibrary(); } catch (e) { library = { error: String(e) }; }
        sendResponse({ ok: true, result: { ...backup, library } });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  // 🆕 QUICK_SAVE — same local named-session save the keyboard command uses,
  // callable from the popup (Dashboard Zap button can now skip its own path).
  if (msg?.type === 'QUICK_SAVE') {
    quickSaveLocally()
      .then(r => sendResponse({ ok: true, ...r }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  // 🖊 MARKUP — open the annotation overlay on the active tab. The overlay app
  // IS the content script (isolated world — the website is never modified),
  // normally already present on http/https pages via manifest content_scripts.
  // Fallback: if it hasn't loaded (install-time edge), inject it via scripting.
  if (msg?.type === 'OPEN_MARKUP') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
          sendResponse({ ok: false, error: 'Markup works on web pages (http/https) — this tab is not one.' });
          return;
        }
        const open = { type: 'ORBITABS_MARKUP_OPEN', url: tab.url };
        let res = null;
        try {
          res = await chrome.tabs.sendMessage(tab.id, open);
        } catch (_) { /* content script not there yet — fall through to inject */ }
        if (!res?.ok) {
          // Install-time edge: the page loaded before the new manifest landed.
          // activeTab (granted by the popup click) authorizes THIS one tab —
          // no broad host permissions are ever requested.
          try {
            await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['markup-overlay.css'] });
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['markup-core.js', 'markup-overlay.js'] });
            // injection's onMessage fires asynchronously — retry the open
            res = await new Promise((resolve) => {
              let done = false;
              chrome.tabs.sendMessage(tab.id, open)
                .then((r) => { done = true; resolve(r); })
                .catch(() => { done = true; resolve(null); });
              setTimeout(() => { if (!done) resolve(null); }, 1500);
            });
          } catch (_) {
            // Chrome refused injection (rare: restricted host or stale grant).
            sendResponse({ ok: false, error: 'Reload this page once (F5), then tap the pen again — Markup will open instantly.' });
            return;
          }
        }
        if (res?.ok) {
          sendResponse({ ok: true, tabId: tab.id });
        } else {
          sendResponse({ ok: false, error: 'Reload this page once (F5), then tap the pen again — Markup will open instantly.' });
        }
      } catch (e) {
        console.error('[Orbitabs] markup open failed:', e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});
