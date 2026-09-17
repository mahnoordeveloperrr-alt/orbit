// 💬 SAVE / RESTORE FEEDBACK — the Day-3 UX gap: actions must never be silent.
//   Save    → "✓ Saved successfully — 23 tabs · 2 windows · 3 groups"
//   Failure → "⚠ Couldn't save your tabs — Your existing data is safe. Try again."
//   Restore → "✓ Session restored — 23 tabs · 2 windows · 3 groups"
//   Partial → "⚠ Session partially restored — 21 of 23 tabs restored."
//
// One small toast lives at the popup's bottom; auto-clears after 5s.
// No animation library — presence/absence only, per the zero-motion rule.

import { useCallback, useEffect, useRef, useState } from 'react';

export const TOAST_MS = 5000;

export function useFeedback() {
  const [toast, setToast] = useState(null); // { kind: 'ok'|'warn'|'err', title, detail }
  const timerRef = useRef(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const show = useCallback((kind, title, detail = '') => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ kind, title, detail });
    timerRef.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const dismiss = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(null);
  }, []);

  return { toast, show, dismiss };
}

/* ---------------- result builders ---------------- */

/** Build counts from a v1 windows[] snapshot. */
export function countWindows(windows) {
  const list = Array.isArray(windows) ? windows : [];
  let tabs = 0;
  let groups = 0;
  for (const w of list) {
    tabs += (w.tabs || []).length;
    groups += (w.groups || []).length;
  }
  return { tabs, windows: list.length, groups };
}

export const summaryOf = ({ tabs, windows, groups }) => {
  const parts = [`${tabs} tab${tabs === 1 ? '' : 's'}`];
  if (windows > 1) parts.push(`${windows} windows`);
  if (groups > 0) parts.push(`${groups} group${groups === 1 ? '' : 's'}`);
  return parts.join(' · ');
};

/** Save outcome → toast payload. `windows` is the captured v1 windows[]. */
export function saveResult(windows) {
  const c = countWindows(windows);
  if (c.tabs === 0) {
    return { kind: 'err', title: "Couldn't save your tabs", detail: 'Nothing to save — no open tabs found. Your existing data is safe.' };
  }
  return { kind: 'ok', title: 'Saved successfully', detail: summaryOf(c) };
}

export function saveFailed(err) {
  return { kind: 'err', title: "Couldn't save your tabs", detail: 'Your existing data is safe. Try again.' + (err ? ` (${err})` : '') };
}

/** Restore outcome → toast payload. `result` is the worker's response. */
export function restoreResult(result, expectedTabs) {
  if (!result?.ok) {
    return { kind: 'err', title: "Couldn't restore your session", detail: 'Your saved session is still in the list — try again.' };
  }
  const restored = result.restoredTabs ?? expectedTabs ?? 0;
  const want = expectedTabs ?? restored;
  if (restored < want) {
    return { kind: 'warn', title: 'Session partially restored', detail: `${restored} of ${want} tabs restored.` };
  }
  return { kind: 'ok', title: 'Session restored', detail: summaryOf(countWindows(result.windows) ) };
}

export function restoreFailed(err) {
  return { kind: 'err', title: "Couldn't restore your session", detail: 'Your saved session is still in the list — try again.' + (err ? ` (${err})` : '') };
}
