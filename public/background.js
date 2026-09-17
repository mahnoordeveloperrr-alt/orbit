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

const API_BASE = 'http://127.0.0.1:5000/api';
const LOCAL_SESSIONS_KEY = 'orbi_sessions'; // same key src/services/store.js reads/writes
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
    res = await fetch(`${API_BASE}/sessions/autosave`, {
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
      const savedTabs = windows.flatMap(w => (w.tabs || [])).filter(t => t.url);
      const focusedWin = windows.find(w => w.focused) || windows[0];
      for (const t of savedTabs) {
        // The saved active tab of the saved focused window lands active here.
        const isActive = o.active && !!t.active && !!focusedWin && (focusedWin.tabs || []).includes(t);
        try {
          await chrome.tabs.create({
            url: t.url,
            ...(cur?.id ? { windowId: cur.id } : {}),
            active: !!isActive,
            ...(o.pinned && t.pinned ? { pinned: true } : {})
          });
          restoredTabs++;
        } catch (e) { /* dead URL — skip, keep the rest */ }
      }
      restoredWindows = 1;
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
      const newest = list
        .filter(s => !s.deletedAt)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      if (!newest) return; // nothing saved yet — stay silent
      await restoreSnapshot({ windows: newest.windows || [] });
    })().catch(e => console.error('[Orbitabs] restore-last command failed:', e));
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

  // Mark "running" for the next exit-crash comparison
  await chrome.storage.local.set({ cleanExit: false, lastAlive: Date.now() });
  flushSnapshot();
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
    syncToBackend().then(r => sendResponse({ ok: true, result: r }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
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
