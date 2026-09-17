import { useState, useRef, useCallback } from 'react';

/**
 * Multi-select for the Organize view — standard conventions:
 * click = select one · Ctrl/Cmd+click = toggle · Shift+click = range
 * (the range follows Chrome's real tab order within the same window).
 * Owns the selection Set, the click policy, the shift-range anchor, and
 * pruning of tabs closed mid-session.
 * All returned callbacks are stable (useCallback) so callers can safely
 * include them in dependency arrays.
 */
export default function useTabSelection() {
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const anchorRef = useRef({ winId: null, tabId: null }); // shift-range anchor

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  /** Selection policy for a click on a tab row. */
  const onTabClick = useCallback((e, tab, win) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(tab.id)) next.delete(tab.id); else next.add(tab.id);
        return next;
      });
      anchorRef.current = { winId: win.id, tabId: tab.id };
      return;
    }
    if (e.shiftKey && anchorRef.current.winId === win.id) {
      const from = win.tabs.findIndex(x => x.id === anchorRef.current.tabId);
      const to = win.tabs.findIndex(x => x.id === tab.id);
      if (from >= 0 && to >= 0) {
        const [a, b] = from <= to ? [from, to] : [to, from];
        setSelectedIds(new Set(win.tabs.slice(a, b + 1).map(x => x.id)));
        return;
      }
    }
    setSelectedIds(new Set([tab.id]));
    anchorRef.current = { winId: win.id, tabId: tab.id };
  }, []);

  /** Ids of the selected tabs in one window, in Chrome's tab order. */
  const idsIn = useCallback((win) => win.tabs.filter(t => selectedIds.has(t.id)).map(t => t.id), [selectedIds]);

  /** Drop selection entries whose tabs no longer exist (closed mid-session);
   *  keeps the same Set identity when nothing changed. */
  const prune = useCallback((windows) => {
    const valid = new Set(windows.flatMap(w => w.tabs.map(t => t.id)));
    setSelectedIds(prev => {
      const next = new Set([...prev].filter(id => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  return { selectedIds, clear, onTabClick, idsIn, prune };
}
