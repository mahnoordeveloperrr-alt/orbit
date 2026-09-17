// 📊 SESSION STATS — one honest summary line per session card.
// "32 tabs · 2 windows · 4 groups" and "Saved 12 min ago".
// Works on legacy docs too (everything goes through normalizeSession).

import { normalizeSession } from '../../services/sessionSchema';

export function sessionStats(session) {
  const v1 = normalizeSession(session);
  const windows = v1?.windows || [];
  let tabs = 0;
  const groupIds = new Set();
  for (const w of windows) {
    tabs += (w.tabs || []).length;
    for (const t of w.tabs || []) if (t.groupId) groupIds.add(t.groupId);
  }
  const groups = windows.reduce((n, w) => n + (w.groups?.length || 0), 0);
  return { tabs, windows: windows.length, groups, hasGroups: groups > 0 };
}

/** "32 tabs · 2 windows · 4 groups" — omits zero-count segments. */
export function sessionSummary(session) {
  const { tabs, windows, groups } = sessionStats(session);
  const parts = [`${tabs} tab${tabs === 1 ? '' : 's'}`];
  if (windows > 1) parts.push(`${windows} windows`);
  if (groups > 0) parts.push(`${groups} group${groups === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** Compact relative time: "just now", "12 min ago", "3 h ago", "2 d ago". */
export function timeAgo(iso) {
  if (!iso) return '';
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.floor(hr / 24);
  return `${day} d ago`;
}
