import React, { useEffect, useState, useCallback } from 'react';
import {
  Plus, Trash2, Ungroup as UngroupIcon, Palette, RefreshCw, GripVertical, Check, X, ChevronDown
} from 'lucide-react';
import { GROUP_DOT_COLORS } from '../../utils/groupColors';
import ConfirmModal from '../common/ConfirmModal';
// Render-model builder + ungrouped-sentinel — single owner, smoke-tested in
// isolation (see scripts/organize-smoke.test.mjs).
import { buildWindowItems, TAB_GROUP_NONE } from './windowItems';
// One owner per concept: multi-select policy (useTabSelection), popover
// chrome + outside-click dismissal (Menu).
import useTabSelection from '../../hooks/useTabSelection';
import Menu from '../common/Menu';

/**
 * Task 5 — MANUAL GROUPING + DRAG & DROP.
 *
 * RENDER MODEL: tabs are listed in Chrome's REAL tab order (the same order
 * windows.getAll returns). Group headers render inline above their first tab;
 * a divider marks the pinned/unpinned boundary. What you see IS the real
 * order — so drop-on-tab reordering always lands exactly where it looks.
 *
 * Drop semantics:
 *   • drop on a group header → add/move the dragged tab(s) into that group
 *   • drop on another tab    → reorder above it (chrome.tabs.move)
 *   • drop on the window's ungroup strip → remove from any group
 *
 * GOLDEN RULE: Orbitabs only changes what the user explicitly drags or edits.
 * Nothing is grouped automatically, no tabs are hidden, no windows are moved.
 */

const COLORS = Object.keys(GROUP_DOT_COLORS);



export default function OrganizePanel() {
  const [windows, setWindows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dragTab, setDragTab] = useState(null);   // { tabId, tabIds, groupId, pinned, fromWinId }
  const [dragOverKey, setDragOverKey] = useState(null); // visual drop highlight
  // 🆕 MULTI-SELECT — click = single, Ctrl/Cmd+click = toggle, Shift+click = range.
  // Dragging a selected tab carries ALL selected tabs of that window.
  const { selectedIds, clear: clearSelection, onTabClick, idsIn: selectedInWin, prune } = useTabSelection();
  // ONE popover-open value: 'color:<groupId>' | 'add' | null — outside-click
  // dismissal is owned by <Menu>, Esc by the global handler below.
  const [menu, setMenu] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [draftTitle, setDraftTitle] = useState('');
  const hasChrome = typeof chrome !== 'undefined' && chrome.tabs?.query;

  // Escape clears the selection + any open menu (standard multi-select UX)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { clearSelection(); setMenu(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearSelection]);

  const refresh = useCallback(async () => {
    if (!hasChrome) { setLoading(false); return; }
    setLoading(true);
    try {
      const wins = await chrome.windows.getAll({ populate: true });
      const out = [];
      for (const win of wins) {
        const tabs = (win.tabs || []).filter(t =>
          (t.url || '') !== '' && !(t.url || '').startsWith('devtools://'));
        let groups = [];
        if (chrome.tabGroups?.query) {
          try { groups = (await chrome.tabGroups.query({ windowId: win.id })) || []; } catch { /* gone */ }
        }
        out.push({
          id: win.id,
          focused: !!win.focused,
          groups,
          tabs: tabs.map(t => ({
            id: t.id,
            title: t.title || t.url,
            url: t.url,
            pinned: !!t.pinned,
            // -1 (ungrouped) → null
            groupId: (typeof t.groupId === 'number' && t.groupId !== TAB_GROUP_NONE)
              ? t.groupId : null
          }))
        });
      }
      setWindows(out);
      prune(out); // drop selection entries whose tabs no longer exist
    } catch (e) { console.error('Organize load failed:', e); }
    setLoading(false);
  }, [hasChrome, prune]);

  useEffect(() => { refresh(); }, [refresh]);

  /* ---------------- group mutations (explicit user actions only) ---------------- */

  const groupTabs = async (tabIds, windowId) => {
    try {
      await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    } catch (e) { console.error('Group failed:', e); }
    refresh();
  };

  const ungroupTabs = async (tabIds) => {
    try { await chrome.tabs.ungroup(tabIds); } catch (e) { console.error('Ungroup failed:', e); }
    refresh();
  };

  const updateGroup = async (groupId, props) => {
    try { await chrome.tabGroups.update(groupId, props); } catch (e) { console.error('Group update failed:', e); }
    refresh();
  };

  const handleDeleteGroup = async (group) => {
    setConfirmDelete(null);
    try {
      const tabsInGroup = (await chrome.tabs.query({ groupId: group.id })) || [];
      const ids = tabsInGroup.map(t => t.id).filter(Boolean);
      if (ids.length > 0) await chrome.tabs.ungroup(ids); // tabs survive — only the group dies
    } catch (e) { console.error('Delete group failed:', e); }
    refresh();
  };

  /** Group ids, then paint a random color. ONE owner for "create a group". */
  const createGroup = async (tabIds, windowId) => {
    try {
      const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(gid, { color: COLORS[Math.floor(Math.random() * COLORS.length)] });
      return gid;
    } catch (e) { console.error('Create group failed:', e); return null; }
  };

  /** New group on a window: from the selection when present, else one seeded
   *  tab (Chrome needs ≥1 tab to create a group). */
  const handleCreateGroup = async (win) => {
    const selInWin = selectedInWin(win);
    const seedId = (win.tabs.find(t => !t.pinned) || win.tabs[0])?.id;
    const ids = selInWin.length > 0 ? selInWin : (seedId ? [seedId] : []);
    if (ids.length === 0) return;
    const gid = await createGroup(ids, win.id);
    if (gid && selInWin.length > 0) clearSelection(); // selection consumed into the new group
    refresh();
  };

  /* ---------------- rename (state-driven input) ---------------- */

  const startRename = (group) => {
    setMenu(null); // close the color popover if it's open
    setEditingGroupId(group.id);
    setDraftTitle(group.title || '');
  };

  const commitRename = async (group) => {
    setEditingGroupId(null);
    const title = draftTitle.trim();
    if (title !== (group.title || '')) await updateGroup(group.id, { title });
  };

  /* ---------------- multi-select + drag ----------------
     Selection policy lives in useTabSelection; here only the drag payload. */

  /** Effective drag set: the whole selection (same window) if the dragged tab
   *  is part of it, otherwise just the dragged tab. */
  const startDrag = (t, win) => {
    const ids = selectedIds.has(t.id)
      ? win.tabs.filter(x => selectedIds.has(x.id)).map(x => x.id)
      : [t.id];
    setDragTab({ tabId: t.id, tabIds: ids, groupId: t.groupId, pinned: t.pinned, fromWinId: win.id });
  };

  /* ---------------- SELECTION ACTIONS — multi-tab → group, the click way ----- */

  const winsWithSelection = () =>
    windows.filter(w => selectedInWin(w).length > 0);

  // Is ANY selected tab currently inside a group? (gates the Ungroup button)
  const anySelectedGrouped = windows.some(w =>
    w.tabs.some(t => selectedIds.has(t.id) && t.groupId));

  /** Add ALL selected tabs of one window into one of its groups (one API call). */
  const handleAddToGroup = async (win) => {
    const ids = selectedInWin(win);
    if (ids.length === 0) return;
    setMenu(null);
    clearSelection();
    await groupTabs(ids, win.id);
  };

  /** Create a new group from the selected tabs — per window that has a selection. */
  const handleBulkNewGroup = async () => {
    for (const win of winsWithSelection()) {
      const ids = selectedInWin(win);
      if (ids.length === 0) continue;
      await createGroup(ids, win.id);
    }
    setMenu(null);
    clearSelection();
    refresh();
  };

  /** Remove every selected tab from its group (all windows). */
  const handleBulkUngroup = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setMenu(null);
    clearSelection();
    await ungroupTabs(ids);
  };

  /* ---------------- drops ---------------- */

  const onDropOnGroup = (group) => {
    setDragOverKey(null);
    if (!dragTab) return;
    const { tabIds, tabId, groupId } = dragTab;
    setDragTab(null);
    const ids = (tabIds && tabIds.length > 1) ? tabIds : [tabId];
    if (groupId === group.id && ids.length === 1) return; // dropped where it already was
    groupTabs(ids, group.windowId); // one tabs.group() call groups them all
  };

  const onDropOnUngrouped = (win) => {
    setDragOverKey(null);
    if (!dragTab) return;
    const { tabIds, tabId, groupId, fromWinId } = dragTab;
    setDragTab(null);
    if (fromWinId !== win.id) return; // strip belongs to this window only
    const ids = (tabIds && tabIds.length > 1) ? tabIds : [tabId];
    if (!groupId && ids.length === 1) return; // single already-ungrouped tab
    ungroupTabs(ids); // bulk ungroup (ungrouping a loose tab is a harmless no-op)
  };

  // 🆕 BULK REORDER — the dragged block (all selected tabs of this window,
  // in their current relative order) lands directly ABOVE the target tab.
  // A local mirror of the tab order lets us compute indexes exactly the way
  // Chrome applies them (move = remove tab, then insert at `index`).
  const onDropOnTab = async (target, win) => {
    setDragOverKey(null);
    const drag = dragTab;
    setDragTab(null);
    if (!drag || drag.fromWinId !== win.id) return; // within-window reorder only

    // Only tabs sharing the dragged tab's pin status can move together —
    // Chrome keeps pinned/unpinned blocks separate.
    const pinStatus = !!drag.pinned;
    const block = win.tabs
      .filter(x => drag.tabIds.includes(x.id) && !!x.pinned === pinStatus)
      .map(x => x.id);
    if (block.length === 0 || (block.length === 1 && block[0] === target.id)) return;

    const arr = win.tabs.map(x => x.id);           // order mirror
    const pinnedCount = win.tabs.filter(x => x.pinned).length;

    for (const id of block) {
      const posT = arr.indexOf(target.id);
      const posD = arr.indexOf(id);
      if (posT < 0 || posD < 0) return;
      // Land above the target (minus the removal shift when dragging downward)
      let idx = posT - (posD < posT ? 1 : 0);
      if (!pinStatus && idx < pinnedCount) idx = pinnedCount;        // keep out of pinned block
      if (pinStatus && idx > pinnedCount - 1) idx = pinnedCount - 1; // stay in pinned block
      if (idx < 0) idx = 0;
      if (idx === posD) continue; // already in place
      try {
        await chrome.tabs.move(id, { windowId: win.id, index: idx });
      } catch (e) { console.error('Tab move failed:', e); return; }
      arr.splice(posD, 1);        // keep the mirror in sync with the real move
      arr.splice(Math.min(idx, arr.length), 0, id);
    }
    refresh();
  };

  const dropHandlers = (key, onDrop) => ({
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverKey !== key) setDragOverKey(key); },
    onDragLeave: () => { if (dragOverKey === key) setDragOverKey(null); },
    onDrop: onDrop
  });

  /* ---------------- render ---------------- */

  if (!hasChrome) {
    return (
      <div className="text-center text-textMuted/60 text-xs py-10">
        Organize needs Chrome extension APIs (open the extension inside Chrome).
      </div>
    );
  }

  const groupHeader = (win, group, count) => {
    const key = `g${group.id}`;
    const isOver = dragOverKey === key;
    const menuOpen = menu === `color:${group.id}`;
    const editing = editingGroupId === group.id;
    const selCount = selectedInWin(win).length;
    return (
      <div
        {...dropHandlers(key, () => onDropOnGroup(group))}
        className={`flex items-center gap-2 pl-1 pr-2 py-1 rounded-lg border transition-colors ${isOver ? 'border-accent bg-accent/10' : 'border-transparent hover:border-borderLight/60'}`}
      >
        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${GROUP_DOT_COLORS[group.color] || 'bg-gray-400'}`} />
        {editing ? (
          <>
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(group);
                if (e.key === 'Escape') setEditingGroupId(null);
              }}
              placeholder="Group name"
              className="flex-1 min-w-0 text-xs font-semibold text-textMain bg-primary border border-accent/40 rounded-md px-1.5 py-0.5 focus:outline-none focus:border-accent"
            />
            <button onClick={() => commitRename(group)} title="Save name" className="p-1 text-accent hover:text-violet-700">
              <Check size={12} />
            </button>
            <button onClick={() => setEditingGroupId(null)} title="Cancel" className="p-1 text-textMuted hover:text-red-500">
              <X size={12} />
            </button>
          </>
        ) : (
          <span
            className="text-xs font-semibold text-textMain truncate cursor-text hover:text-accent transition-colors"
            onClick={() => startRename(group)}
            title="Click to rename"
          >
            {group.title || 'Untitled'}
          </span>
        )}
        <span className="text-[10px] text-textMuted flex-shrink-0">({count})</span>
        {/* 🆕 Quick add: with an active selection, every header gets a + button */}
        {selCount > 0 && !editing && (
          <button
            onClick={() => handleAddToGroup(win)}
            title={`Add ${selCount} selected tab${selCount > 1 ? 's' : ''} to this group`}
            className="p-1 text-accent hover:text-violet-700 border border-accent/40 rounded-full transition-colors"
          >
            <Plus size={12} />
          </button>
        )}
        {!editing && (
          <div className="ml-auto flex items-center gap-0.5 relative">
            <button
              onClick={() => setMenu(menuOpen ? null : `color:${group.id}`)}
              className="p-1 text-textMuted hover:text-accent transition-colors"
              title="Change color"
            >
              <Palette size={12} />
            </button>
            <button
              onClick={() => setConfirmDelete(group)}
              className="p-1 text-textMuted hover:text-red-500 transition-colors"
              title="Delete group (tabs are kept)"
            >
              <Trash2 size={12} />
            </button>
            <Menu
              open={menuOpen}
              onClose={() => setMenu(null)}
              className="top-6 right-0 p-2 flex gap-1.5 rounded-lg"
            >
              {COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => { updateGroup(group.id, { color: c }); setMenu(null); }}
                  className={`w-4 h-4 rounded-full ${GROUP_DOT_COLORS[c]} ${c === group.color ? 'ring-2 ring-offset-1 ring-accent' : ''}`}
                  title={c}
                />
              ))}
            </Menu>
          </div>
        )}
      </div>
    );
  };

  const tabRow = (t, win, inGroup) => {
    const group = t.groupId ? win.groups.find(g => g.id === t.groupId) : null;
    const isDragging = dragTab?.tabId === t.id;
    const isSelected = selectedIds.has(t.id);
    const tabKey = `t${t.id}`;
    const isOverTab = dragOverKey === tabKey;
    return (
      <div
        key={t.id}
        draggable
        onClick={(e) => onTabClick(e, t, win)}
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; startDrag(t, win); }}
        onDragEnd={() => { setDragTab(null); setDragOverKey(null); }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; if (dragOverKey !== tabKey) setDragOverKey(tabKey); }}
        onDragLeave={() => { if (dragOverKey === tabKey) setDragOverKey(null); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropOnTab(t, win); }}
        className={`flex items-center gap-2 py-1.5 pr-2 rounded-lg border text-xs cursor-grab active:cursor-grabbing transition-colors ${isDragging ? 'opacity-40' : ''} ${isSelected ? 'border-accent bg-accent/10 ring-1 ring-accent/40' : isOverTab ? 'border-accent bg-accent/10' : 'border-borderLight/50 bg-primary/70 hover:border-accent/40'}`}
        style={inGroup && group ? { borderLeft: `3px solid currentColor` } : undefined}
        title={`${t.title}\n${t.url}\n\nClick = select · Ctrl/Cmd+click = toggle · Shift+click = range\nDrop a tab here to reorder (lands above this tab)`}
      >
        <GripVertical size={12} className="text-textMuted/50 flex-shrink-0" />
        {group && <span className={`w-2 h-2 rounded-full flex-shrink-0 ${GROUP_DOT_COLORS[group.color] || 'bg-gray-400'}`} />}
        <span className="truncate flex-1">{t.title}</span>
        {t.pinned && <span className="text-[9px] text-textMuted flex-shrink-0">📌</span>}
      </div>
    );
  };

  return (
    <div className="space-y-4 relative z-10">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs text-textMuted">
          Real tab order · drop on a tab to reorder, on a group header to add,
          on the strip to ungroup. Nothing is grouped automatically.
        </p>
        <div className="flex items-center gap-1.5">
          <button
            onClick={refresh}
            title="Refresh live state"
            className="text-textMuted hover:text-accent transition-colors p-1"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {dragTab && dragTab.tabIds?.length > 1 && (
        <div className="glass rounded-lg px-3 py-1.5 text-[11px] font-semibold text-accent flex items-center gap-2 relative z-20">
          <GripVertical size={12} /> Moving {dragTab.tabIds.length} tabs — drop on a group header / tab / strip
        </div>
      )}

      {/* 🆕 SELECTION ACTION BAR — multi-tab → group without any drag precision.
          Sticky so it stays reachable while scrolling long window lists. */}
      {selectedIds.size > 0 && (
        <div className="glass sticky top-0 z-30 rounded-xl p-2 flex items-center gap-1.5 flex-wrap shadow-md">
          <span className="text-[11px] font-bold text-accent bg-accent/10 border border-accent/20 px-2 py-1 rounded-full flex-shrink-0">
            {selectedIds.size} selected
          </span>

          <div className="relative">
            <button
              onClick={() => setMenu(menu === 'add' ? null : 'add')}
              aria-expanded={menu === 'add'}
              title="Add the selected tabs to a group"
              className="flex items-center gap-1 text-[11px] font-semibold text-textMain bg-primary border border-borderLight/60 hover:border-accent px-2.5 py-1 rounded-full transition-colors"
            >
              Add to group
              <ChevronDown size={12} className={`text-textMuted transition-transform ${menu === 'add' ? 'rotate-180' : ''}`} />
            </button>
            <Menu
              open={menu === 'add'}
              onClose={() => setMenu(null)}
              className="left-0 top-8 p-1.5 w-64 max-h-64 overflow-y-auto custom-scrollbar"
            >
              {winsWithSelection().length === 0 && (
                <p className="text-[10px] text-textMuted px-1.5 py-1">No selection</p>
              )}
              {winsWithSelection().map((w, i) => (
                <div key={w.id} className={i > 0 ? 'mt-1 pt-1 border-t border-borderLight/60' : ''}>
                  {/* Single-window (the common case) → skip the header noise */}
                  {winsWithSelection().length > 1 && (
                    <p className="text-[9px] uppercase tracking-wide text-textMuted px-1.5 py-1">
                      Window {w.id} · {selectedInWin(w).length} tab{selectedInWin(w).length > 1 ? 's' : ''}
                    </p>
                  )}
                  {w.groups.length === 0 ? (
                    <p className="text-[10px] text-textMuted/70 px-1.5 py-1 italic">No groups yet — use “New group”</p>
                  ) : (
                    w.groups.map(g => {
                      const allIn = w.tabs.filter(t => selectedIds.has(t.id)).every(t => t.groupId === g.id);
                      const size = w.tabs.filter(t => t.groupId === g.id).length;
                      return (
                        <button
                          key={g.id}
                          disabled={allIn}
                          title={allIn ? 'All selected tabs are already in this group' : undefined}
                          onClick={() => handleAddToGroup(w)}
                          className={`flex items-center gap-2 w-full text-left text-[11px] rounded-md px-1.5 py-1.5 transition-colors ${allIn ? 'opacity-45 cursor-default' : 'text-textMain hover:bg-muted'}`}
                        >
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${GROUP_DOT_COLORS[g.color] || 'bg-gray-400'}`} />
                          <span className="truncate flex-1">{g.title || 'Untitled'}</span>
                          <span className="text-[9px] text-textMuted flex-shrink-0">{size}</span>
                          {allIn
                            ? <Check size={11} className="text-accent flex-shrink-0" />
                            : <Plus size={11} className="text-accent flex-shrink-0" />}
                        </button>
                      );
                    })
                  )}
                </div>
              ))}
            </Menu>
          </div>

          <button
            onClick={handleBulkNewGroup}
            title="Create a new group from the selected tabs"
            className="flex items-center gap-1 text-[11px] font-semibold text-onAccent bg-accent hover:opacity-90 px-2.5 py-1 rounded-full transition-colors shadow-sm flex-shrink-0"
          >
            <Plus size={11} /> New group
          </button>

          <button
            onClick={handleBulkUngroup}
            disabled={!anySelectedGrouped}
            title={anySelectedGrouped ? 'Remove the selected tabs from any group' : 'No selected tab is in a group'}
            className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors flex-shrink-0 ${anySelectedGrouped ? 'text-textMuted bg-muted border-borderLight/60 hover:text-red-500' : 'text-textMuted/40 bg-muted border-borderLight/60 cursor-default'}`}
          >
            <UngroupIcon size={11} /> Ungroup
          </button>

          <button
            onClick={clearSelection}
            title="Clear selection (Esc)"
            className="ml-auto text-textMuted hover:text-red-500 p-1 transition-colors flex-shrink-0"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {loading && windows.length === 0 ? (
        <p className="text-center text-textMuted text-xs py-6">Loading live tabs…</p>
      ) : windows.length === 0 ? (
        <p className="text-center text-textMuted/60 text-xs py-6">No windows with tabs.</p>
      ) : (
        windows.map((win) => {
          // Build the render list in Chrome's REAL tab order with inline group
          // headers (above each group's first tab) + a pinned-boundary divider.
          const items = buildWindowItems(win);

          const stripKey = `u${win.id}`;
          const stripOver = dragOverKey === stripKey;

          return (
            <div key={win.id} className="glass rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-textMain">
                  Window {win.id} {win.focused && <span className="text-accent text-[10px] ml-1">● current</span>}
                </span>
                <button
                  onClick={() => handleCreateGroup(win)}
                  className="flex items-center gap-1 text-[11px] font-medium text-accent hover:text-violet-700 transition-colors"
                >
                  <Plus size={12} /> New group
                </button>
              </div>

              <div className="space-y-1">
                {items.map(item => {
                  if (item.type === 'header') return <div key={item.key}>{groupHeader(item.win, item.group, item.count)}</div>;
                  if (item.type === 'divider') return (
                    <div key={item.key} className="flex items-center gap-2 px-2 py-1" title="Pinned / normal boundary — Chrome keeps these blocks separate">
                      <div className="flex-1 border-t border-dashed border-borderLight" />
                      <span className="text-[9px] uppercase tracking-wide text-textMuted/70">pinned ↑</span>
                    </div>
                  );
                  return tabRow(item.tab, item.win, item.inGroup);
                })}
              </div>

              {/* Ungroup strip — the drop target for removing tabs from groups */}
              <div
                {...dropHandlers(stripKey, () => onDropOnUngrouped(win))}
                className={`mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-dashed py-1.5 transition-colors ${stripOver ? 'border-accent bg-accent/10' : 'border-borderLight/70'}`}
              >
                <UngroupIcon size={11} className="text-textMuted" />
                <span className="text-[10px] font-medium text-textMuted uppercase tracking-wide">
                  Drop here to ungroup
                </span>
              </div>
            </div>
          );
        })
      )}

      <ConfirmModal
        open={!!confirmDelete}
        title="Delete this group?"
        message={`"${confirmDelete?.title || 'Untitled'}" will be removed. Its tabs stay open — they just become ungrouped. Chrome groups you didn't touch are never affected.`}
        confirmLabel="Ungroup tabs"
        danger
        onConfirm={() => handleDeleteGroup(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
