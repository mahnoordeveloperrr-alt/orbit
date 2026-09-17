// ============================================================================
// ORBITABS SESSION SNAPSHOT v1 — LOCKED SCHEMA (Day 2, Task 1)
// ============================================================================
// EVERY session — named save, quick save, auto-save live backup, crash
// recovery candidate, cloud doc — is normalized into THIS shape before use.
// Do not create per-feature shapes; extend this file instead, or save/restore
// code will keep getting rewritten (the exact problem this locks down).
//
// v1 = {
//   name: string,
//   createdAt: ISO string,
//   updatedAt: ISO string,
//   windows: [{
//     state: 'normal' | 'minimized' | 'maximized' | 'fullscreen',
//     focused: boolean,
//     tabs: [{                      // array order = visual tab order
//       url: string,                // required — the restore key
//       title: string,
//       pinned: boolean,
//       active: boolean,            // meaningful within its own window
//       groupId: string | null,     // membership: matches groups[].id
//     }],
//     groups: [{                    // definitions only — no membership here
//       id: string,                 // stable within its window ("g1", "g2"…)
//       title: string,              // '' = Chrome's default colored group
//       color: ChromeColor,         // grey|blue|red|yellow|green|pink|purple|cyan|orange
//       collapsed: boolean,
//     }],
//   }],
// }
//
// LOCKED RULES:
// 1. Membership is tab.groupId === group.id, scoped to the SAME window.
//    No positional index arrays anywhere — indices break on every tab move,
//    and Phase 3 (manual grouping / drag & drop) depends on stable ids.
// 2. Tab order within a window IS the array order. Windows are restored in
//    array order; the window with focused:true gets focus at the end.
// 3. Legacy sessions ({ urls[], groups[].urlIndices }) are normalized on read
//    and lazily upgraded to v1 on write — no one-time migration script.
// ============================================================================

export const SCHEMA_VERSION = 1;

// The 9 colors Chrome's tabGroups API can return
export const CHROME_COLORS = [
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'
];

const VALID_STATES = new Set(['normal', 'minimized', 'maximized', 'fullscreen']);

const validColor = (c) => (CHROME_COLORS.includes(c) ? c : 'grey');

const safeIso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

/* ------------------------------------------------------------------ *
 * CAPTURE — live Chrome state → v1 windows[]
 * ------------------------------------------------------------------ */

/**
 * Capture ALL browser windows as v1 `windows[]` (tabs + group definitions).
 * Works in the popup and anywhere the extension APIs exist. Returns [] when
 * Chrome APIs are unavailable (e.g. dev preview outside Chrome).
 *
 * NOTE: public/background.js has a self-contained copy of this logic (MV3
 * classic workers can't import ESM). Keep the two in sync — same shape.
 */
export async function captureAllWindowsV1() {
  if (typeof chrome === 'undefined' || !chrome.windows?.getAll) return [];

  const wins = await chrome.windows.getAll({ populate: true });
  const out = [];

  for (const win of wins) {
    // Real user tabs only — skip extension pages/devtools
    const tabs = (win.tabs || []).filter(t => {
      const u = t.url || t.pendingUrl || '';
      return u !== '' && !u.startsWith('devtools://');
    });
    if (tabs.length === 0) continue;

    // Group metadata for this window (chromeGroupId -> {title,color,collapsed})
    const groupMeta = new Map();
    if (chrome.tabGroups?.query) {
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
            color: validColor(meta.color),
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

    // Drop group definitions whose tabs all vanished mid-capture
    const referenced = new Set(tabData.map(t => t.groupId).filter(Boolean));

    out.push({
      state: VALID_STATES.has(win.state) ? win.state : 'normal',
      focused: !!win.focused,
      tabs: tabData.filter(t => t.url),
      groups: groupsOut.filter(g => referenced.has(g.id)),
      _windowId: win.id // internal: used by captureCurrentWindowV1, stripped on normalize
    });
  }
  return out;
}

/**
 * Capture ONLY the current window as v1 windows[] (single-element array).
 * Used by "Save current window" scope. Reuses the all-windows capture and
 * filters to the window the popup is open in, so the shape is identical.
 */
export async function captureCurrentWindowV1() {
  const all = await captureAllWindowsV1();
  if (all.length === 0) return [];
  if (typeof chrome === 'undefined' || !chrome.windows?.getCurrent) return all;
  try {
    const current = await chrome.windows.getCurrent();
    const mine = all.find(w => w._windowId === current.id);
    // captureAllWindowsV1 doesn't keep window ids; fall back to the focused
    // window (the popup's window is virtually always focused when saving).
    return mine ? [mine] : [all.find(w => w.focused) || all[0]];
  } catch {
    return [all.find(w => w.focused) || all[0]];
  }
}

function sanitizeWindows(windows) {
  const out = [];
  (Array.isArray(windows) ? windows : []).forEach(w => {
    if (!w || typeof w !== 'object') return;
    const tabs = (Array.isArray(w.tabs) ? w.tabs : [])
      .map(t => (t && typeof t === 'object' ? {
        url: String(t.url || '').trim(),
        title: String(t.title || ''),
        pinned: !!t.pinned,
        active: !!t.active,
        groupId: t.groupId != null && t.groupId !== '' ? String(t.groupId) : null
      } : null))
      .filter(t => t && t.url);
    if (tabs.length === 0) return;

    const groups = (Array.isArray(w.groups) ? w.groups : []).map((g, i) => ({
      id: g && g.id != null ? String(g.id) : `g${i + 1}`,
      title: String(g?.title || ''),
      color: validColor(g?.color),
      collapsed: !!g?.collapsed
    }));
    const referenced = new Set(tabs.map(t => t.groupId).filter(Boolean));

    out.push({
      state: VALID_STATES.has(w.state) ? w.state : 'normal',
      focused: !!w.focused,
      tabs,
      groups: groups.filter(g => referenced.has(g.id))
    }); // normalize strips internal _windowId
  });
  return out;
}

/** LEGACY { urls[], groups[].urlIndices } → v1 windows[] (single window). */
function legacyToV1(raw) {
  const urls = (Array.isArray(raw.urls) ? raw.urls : [])
    .map(u => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
  if (urls.length === 0) return [];

  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  const tabGroups = [];
  const tabData = urls.map((url, i) => {
    let groupId = null;
    const g = groups.find(g => g && Array.isArray(g.urlIndices) && g.urlIndices.includes(i));
    if (g) {
      if (!g._id) {
        g._id = `g${tabGroups.length + 1}`;
        tabGroups.push({
          id: g._id,
          title: String(g.title || ''),
          color: validColor(g.color),
          collapsed: !!g.collapsed
        });
      }
      groupId = g._id;
    }
    return { url, title: '', pinned: false, active: false, groupId };
  });

  return [{ state: 'normal', focused: true, tabs: tabData, groups: tabGroups }];
}

/**
 * Normalize ANY stored/fetched session doc into the v1 view.
 * Returns null for docs with no restorable tabs (corrupt/empty) — callers
 * must handle null. Pure function: never mutates the input.
 */
/** A session's identity, wherever it came from (store writes `_id`; legacy
 *  and cloud shapes may carry `id`). ONE read path for the whole UI. */
export function sid(session) {
  return session?._id || session?.id || null;
}

export function normalizeSession(raw) {
  // NB: `raw === null` check (not falsy) AND typeof — null/42/"str"/true must
  // return null (skipped), never crash on property access (beta import gate).
  if (raw === null || typeof raw !== 'object') return null;

  let windows = null;
  if (Array.isArray(raw.windows)) {
    windows = sanitizeWindows(raw.windows);
  } else if (Array.isArray(raw.urls)) {
    windows = legacyToV1(raw); // legacy → v1 in memory
  }
  if (!windows || windows.length === 0) return null;

  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : 'Untitled session';

  return {
    _id: raw._id || raw.id || null,
    name,
    schemaVersion: SCHEMA_VERSION,
    windows,
    isAutoSave: !!raw.isAutoSave,
    autoKey: raw.autoKey ?? null,
    deletedAt: safeIso(raw.deletedAt),
    pinned: !!raw.pinned, // 📌 user pin — preserved on every normalize pass
    createdAt: safeIso(raw.createdAt),
    updatedAt: safeIso(raw.updatedAt) || safeIso(raw.createdAt)
  };
}
