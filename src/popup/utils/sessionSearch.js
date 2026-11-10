// 🔍 SESSION SEARCH — pure helpers, no Chrome APIs (unit-testable in isolation).
//
// Matches a query against a session's NAME and every saved tab's URL + TITLE.
// Case-insensitive substring match; empty/whitespace query matches everything.
// Works on RAW store docs — normalization (legacy urls[] docs included) happens
// through the same normalizeSession() view the rest of the UI uses.

import { normalizeSession } from '../../services/sessionSchema';

/**
 * Does `session` match `query`?
 * True when the name, any tab url, any tab title, any TAG, the note, or the
 * folder contains the query (case-insensitive). A URL match highlights the
 * whole session — you don't need to remember which session had that one
 * article open.
 */
export function sessionMatchesQuery(session, rawQuery) {
  const q = (rawQuery || '').trim().toLowerCase();
  if (!q) return true; // empty query = no filter

  const v1 = normalizeSession(session);
  if (!v1) return false; // corrupt/empty doc — hidden when filtering is active

  if (v1.name.toLowerCase().includes(q)) return true;

  // 🆕 V1.5 metadata — tags/note/folder are searchable like everything else
  if ((v1.tags || []).some(t => t.toLowerCase().includes(q))) return true;
  if (v1.note && v1.note.toLowerCase().includes(q)) return true;
  if (v1.folder && v1.folder.toLowerCase().includes(q)) return true;

  return v1.windows.some(w =>
    w.tabs.some(t =>
      (t.url || '').toLowerCase().includes(q) ||
      (t.title || '').toLowerCase().includes(q)
    )
  );
}

/**
 * Filter + keep the original sort order (store returns newest-first).
 * Returns a NEW array; never mutates the input.
 */
export function filterSessions(sessions, rawQuery) {
  const list = Array.isArray(sessions) ? sessions : [];
  const q = (rawQuery || '').trim();
  if (!q) return list;
  return list.filter(s => sessionMatchesQuery(s, q));
}
