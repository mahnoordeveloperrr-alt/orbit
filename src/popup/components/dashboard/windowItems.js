// Pure helpers for OrganizePanel's render model — no React, no Chrome APIs.
// Kept in a plain .js module so node-based tests can import it directly.

// Chrome marks UNGROUPED tabs with groupId === -1 — must be treated as null.
export const TAB_GROUP_NONE = -1;

/**
 * Build the render list for one window in Chrome's REAL tab order: an inline
 * group header above each group's first tab, that group's tabs after it, and
 * a pinned/unpinned boundary divider at the end of the pinned block.
 *
 * Every item carries `win` — renderers derive window-scoped state from it.
 * (Regression: header items once omitted `win`, so groupHeader(item.win, …)
 * threw on the first grouped tab and blanked the whole popup.)
 */
export function buildWindowItems(win) {
  const counts = {};
  win.tabs.forEach(t => { if (t.groupId) counts[t.groupId] = (counts[t.groupId] || 0) + 1; });
  const lastPinned = win.tabs.reduce((acc, t, i) => (t.pinned ? i : acc), -1);
  const seen = new Set();
  const items = [];
  win.tabs.forEach((t, i) => {
    // Resolve membership HERE: a groupId with no matching group definition
    // (API race) renders as an ungrouped tab, never as a phantom member.
    const g = t.groupId ? win.groups.find(gg => gg.id === t.groupId) : null;
    if (g && !seen.has(g.id)) {
      seen.add(g.id);
      items.push({ type: 'header', key: `h${g.id}`, group: g, count: counts[g.id], win });
    }
    items.push({ type: 'tab', key: `t${t.id}`, tab: t, inGroup: !!g, win });
    if (i === lastPinned && lastPinned !== win.tabs.length - 1) {
      items.push({ type: 'divider', key: 'pin-div', win });
    }
  });
  return items;
}
