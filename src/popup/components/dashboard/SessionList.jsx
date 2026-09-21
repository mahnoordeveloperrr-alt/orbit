import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, ChevronUp, Trash2, ArrowLeft, RotateCcw, MoreVertical,
  Pencil, Copy, Download, FolderOpen, Pin, PinOff
} from 'lucide-react';
import Card from '../common/Card';
import { dotClassFor } from '../../utils/groupColors';
// 🆕 LOCAL-FIRST: trash/restore/purge operate on chrome.storage.local via store.js
import {
  getTrash, restoreSession, purgeSession, emptyTrash, renameSession,
  duplicateSession, setSessionPinned
} from '../../../services/store';
// 🆕 v1 schema — every session is viewed through the locked snapshot shape
import { normalizeSession, sid } from '../../../services/sessionSchema';
// 📊 Card summary line + relative time — "32 tabs · 2 windows · 4 groups", "12 min ago"
import { sessionSummary, timeAgo } from '../../utils/sessionStats';
// 📦 Single-session export (card ⋯ menu)
import { downloadOneSession } from '../../utils/sessionBackup';

// Trust rule: NEVER rewrite a URL that already carries a scheme —
// chrome://, file://, edge://, ftp:// all open as saved. Only bare hosts
// from very old sessions get https:// prepended.
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const normalizeUrl = (url) => {
  if (!url) return '';
  return HAS_SCHEME.test(url) ? url : 'https://' + url;
};

export default function SessionList({ sessions, onDelete, onRenamed, onRestoreResult }) {
  const [expandedId, setExpandedId] = useState(null);
  // 🆕 inline rename — click a session's name or ⋯ → Rename (AUTO card is not renamable)
  const [editingId, setEditingId] = useState(null);
  const [draftName, setDraftName] = useState('');
  // 🆕 three-dot menu — one open at a time; closes on outside click
  const [menuId, setMenuId] = useState(null);
  // Open upward when the card sits near the popup's bottom edge, so the menu
  // is never clipped by the scroll container.
  const [menuUp, setMenuUp] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuId) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuId(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuId]);

  const commitRename = async (uid) => {
    setEditingId(null);
    const name = draftName.trim();
    if (!name) return; // empty → keep old name
    try {
      await renameSession(uid, name);
      onRenamed?.();
    } catch (err) { console.error('Rename failed:', err); }
  };

  const handleDuplicate = async (uid) => {
    setMenuId(null);
    try {
      await duplicateSession(uid);
      onRenamed?.(); // reload list — the copy appears at the top
    } catch (err) { console.error('Duplicate failed:', err); }
  };

  // 📌 Pin/unpin — pinned sessions sort above everything else in the list
  const handleTogglePin = async (session) => {
    setMenuId(null);
    try {
      await setSessionPinned(sid(session), !session.pinned);
      onRenamed?.(); // reload — same refresh path as rename/duplicate
    } catch (err) { console.error('Pin toggle failed:', err); }
  };

  const handleExportOne = (session) => {
    setMenuId(null);
    try {
      downloadOneSession(session);
      onRestoreResult?.({ kind: 'ok', title: 'Session exported', detail: 'JSON file downloaded' });
    } catch (err) {
      console.error('Export failed:', err);
      onRestoreResult?.({ kind: 'err', title: "Couldn't export the session", detail: 'Try again.' });
    }
  };

  // 🆕 TRASH — open, restore (undo), purge (permanent), empty
  const openTrash = async () => {
    setShowTrash(true);
    setTrashLoading(true);
    try {
      const res = await getTrash();
      setTrashItems(res.data);
    } catch (err) { console.error('Trash load failed:', err); }
    setTrashLoading(false);
  };

  const [showTrash, setShowTrash] = useState(false);
  const [trashItems, setTrashItems] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);

  const toggleExpand = (id) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  // Flip the menu above the button when less than ~menu-height of room remains.
  const toggleMenu = (id, e) => {
    if (menuId === id) { setMenuId(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 560;
    setMenuUp(vh - rect.bottom < 170);
    setMenuId(id);
  };

  const openTab = (url) => {
    if (!url) return;
    try {
      const fullUrl = normalizeUrl(url);
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        chrome.tabs.create({ url: fullUrl });
      } else {
        window.open(fullUrl, '_blank');
      }
    } catch (err) {
      console.error("Tab open error:", err);
    }
  };

  // 🆕 v1 RESTORE — the service worker owns the multi-window rebuild (windows,
  // groups, pinned, active, order, focus). The worker reports restoredTabs, so
  // a partial restore (dead URLs) is visible to the user, never silent.
  const restoreTabs = async (session) => {
    const v1 = normalizeSession(session);
    if (!v1) return;
    const expected = (v1.windows || []).reduce((n, w) => n + (w.tabs || []).length, 0);
    v1.windows.forEach(w => w.tabs.forEach(t => { t.url = normalizeUrl(t.url); }));

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'RESTORE_SESSION', session: v1 });
        if (res?.ok && res.restoredTabs !== undefined) {
          onRestoreResult?.({ ok: true, restoredTabs: res.restoredTabs, expectedTabs: expected, windows: v1.windows });
        } else if (!res?.ok) {
          onRestoreResult?.({ ok: false });
          console.error('Restore failed:', res);
        }
        return;
      } catch (err) {
        console.error('Restore message failed:', err);
        onRestoreResult?.({ ok: false, error: String(err) });
        return;
      }
    }
    // Fallback (dev preview outside Chrome): open every tab flat
    v1.windows.forEach(w => w.tabs.forEach(t => openTab(t.url)));
    onRestoreResult?.({ ok: true, restoredTabs: expected, expectedTabs: expected, windows: v1.windows });
  };

  const handleTrashRestore = async (id) => {
    try {
      await restoreSession(id);
      setTrashItems(prev => prev.filter(s => sid(s) !== id));
    } catch (err) { console.error('Restore failed:', err); }
  };

  const handlePurge = async (id) => {
    if (!window.confirm('Permanently delete this session? This cannot be undone.')) return;
    try {
      await purgeSession(id);
      setTrashItems(prev => prev.filter(s => sid(s) !== id));
    } catch (err) { console.error('Purge failed:', err); }
  };

  const handleEmptyTrash = async () => {
    if (!window.confirm('Permanently delete ALL trashed sessions? This cannot be undone.')) return;
    try {
      await emptyTrash();
      setTrashItems([]);
    } catch (err) { console.error('Empty trash failed:', err); }
  };

  // 🗑️ TRASH VIEW
  if (showTrash) {
    return (
      <div className="space-y-3 mt-4">
        <div className="flex items-center justify-between px-2 py-2 text-xs text-textMuted border-b border-borderLight/50 pb-2">
          <button
            onClick={() => setShowTrash(false)}
            className="flex items-center gap-1 hover:text-accent font-medium transition-colors"
          >
            <ArrowLeft size={14} /> Back to sessions
          </button>
          {trashItems.length > 0 && (
            <button
              onClick={handleEmptyTrash}
              className="text-red-500 hover:text-red-600 font-medium flex items-center gap-1 transition-colors"
            >
              <Trash2 size={14} /> Empty Trash
            </button>
          )}
        </div>

        {trashLoading ? (
          <p className="text-center text-textMuted text-xs py-6">Loading trash…</p>
        ) : trashItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-textMuted/60">
            <Trash2 size={40} className="stroke-1 mb-2 opacity-50" />
            <p className="text-sm font-medium">Trash is empty</p>
            <p className="text-xs opacity-70">Deleted sessions stay here for 30 days</p>
          </div>
        ) : (
          trashItems.map((session) => {
            const uid = sid(session);
            return (
              <Card key={uid} className="session-card p-4">
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center gap-3">
                    <FolderOpen className="text-textMuted w-5 h-5 flex-shrink-0" />
                    <div>
                      <h4 className="font-medium text-textMain text-sm">{session.name}</h4>
                      <div className="flex items-center gap-1 text-textMuted text-xs">
                        <span>{sessionSummary(session)}</span>
                        <span className="ml-1">
                          deleted {session.deletedAt ? timeAgo(session.deletedAt) : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleTrashRestore(uid)}
                      className="flex items-center gap-1 text-accent hover:text-blue-700 text-sm font-medium px-2"
                    >
                      <RotateCcw size={14} /> Restore
                    </button>
                    <button
                      onClick={() => handlePurge(uid)}
                      className="text-red-500 hover:text-red-600 text-sm font-medium px-2"
                    >
                      Delete forever
                    </button>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 mt-2">
      {sessions.map((session) => {
        const uniqueId = sid(session);
        const v1 = normalizeSession(session); // 🆕 v1 view (also covers legacy docs)
        // NB: no overflow-hidden on this card — it clipped the card's ⋯ dropdown menu
        return (
          <Card key={uniqueId} className={`session-card session-card-${uniqueId} p-3.5`}>
            <div className="flex items-center justify-between w-full gap-2">

              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {editingId === uniqueId ? (
                      <input
                        autoFocus
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        onBlur={() => commitRename(uniqueId)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(uniqueId);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="text-sm font-medium text-textMain bg-primary border border-accent/40 rounded-md px-1.5 py-0.5 focus:outline-none focus:border-accent w-40"
                      />
                    ) : (
                      <h4
                        onClick={() => {
                          if (session.isAutoSave) return; // worker overwrites AUTO names
                          setDraftName(session.name || '');
                          setEditingId(uniqueId);
                        }}
                        title={session.isAutoSave ? 'Managed by auto-save' : 'Click to rename'}
                        className={`font-medium text-textMain text-sm truncate ${session.isAutoSave ? '' : 'cursor-text hover:text-accent'}`}
                      >
                        {session.name}
                      </h4>
                    )}
                    {/* AUTO badge — maintained by the background auto-save worker */}
                    {session.isAutoSave && (
                      <span className="text-[10px] font-bold text-accent bg-accent/10 border border-accent/20 px-1.5 py-0.5 rounded-full flex-shrink-0">
                        AUTO
                      </span>
                    )}
                    {/* 📌 pinned-to-top indicator */}
                    {session.pinned && (
                      <span title="Pinned to top" className="flex-shrink-0 text-amber-500">
                        <Pin size={12} fill="currentColor" />
                      </span>
                    )}
                  </div>

                  {/* Summary line — "32 tabs · 2 windows · 4 groups" + "Saved 12 min ago" */}
                  <div className="flex items-center gap-1.5 text-textMuted text-xs mt-0.5">
                    <span>{sessionSummary(session)}</span>
                    <span>·</span>
                    <span>Saved {timeAgo(session.createdAt)}</span>
                  </div>

                  {/* Chrome tab groups at a glance — color dot + title + count */}
                  {(v1?.windows || []).length > 0 && (() => {
                    const groups = v1.windows.flatMap(w => {
                      const counts = {};
                      (w.tabs || []).forEach(t => { if (t.groupId) counts[t.groupId] = (counts[t.groupId] || 0) + 1; });
                      return (w.groups || []).map(g => ({ ...g, tabCount: counts[g.id] || 0 }));
                    });
                    if (groups.length === 0) return null;
                    return (
                      <div className="flex flex-wrap items-center gap-1 mt-1.5">
                        {groups.map((g, gi) => (
                          <span
                            key={gi}
                            className="flex items-center gap-1 bg-muted text-textMuted text-[10px] px-1.5 py-0.5 rounded-full border border-borderLight/50"
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${dotClassFor(g.color)}`} />
                            <span className="font-medium">{g.title || 'Group'}</span>
                            <span>{g.tabCount || 0}</span>
                          </span>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>

              <div className="flex items-center gap-0.5 flex-shrink-0">
                {/* Expand → saved links */}
                <button
                  onClick={() => toggleExpand(uniqueId)}
                  title="Show saved links"
                  className="text-textMuted hover:text-accent transition-colors p-1.5"
                >
                  {expandedId === uniqueId ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>

                {/* Three-dot menu — Rename · Duplicate · Export · Delete */}
                <div className="relative">
                  <button
                    onClick={(e) => toggleMenu(uniqueId, e)}
                    title="More actions"
                    className="text-textMuted hover:text-accent transition-colors p-1.5"
                  >
                    <MoreVertical size={15} />
                  </button>
                  {menuId === uniqueId && (
                    <div
                      ref={menuRef}
                      className={`absolute right-0 z-30 w-40 bg-primary rounded-xl border border-borderLight shadow-premium-lg py-1 ${menuUp ? 'bottom-8' : 'top-8'}`}
                    >
                      <button
                        onClick={() => {
                          setMenuId(null);
                          if (session.isAutoSave) return;
                          setDraftName(session.name || '');
                          setEditingId(uniqueId);
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs text-textMain hover:bg-muted flex items-center gap-2"
                      >
                        <Pencil size={12} className="text-textMuted" /> Rename
                      </button>
                      <button
                        onClick={() => handleDuplicate(uniqueId)}
                        className="w-full text-left px-3 py-1.5 text-xs text-textMain hover:bg-muted flex items-center gap-2"
                      >
                        <Copy size={12} className="text-textMuted" /> Duplicate
                      </button>
                      <button
                        onClick={() => handleExportOne(session)}
                        className="w-full text-left px-3 py-1.5 text-xs text-textMain hover:bg-muted flex items-center gap-2"
                      >
                        <Download size={12} className="text-textMuted" /> Export
                      </button>
                      <button
                        onClick={() => handleTogglePin(session)}
                        className="w-full text-left px-3 py-1.5 text-xs text-textMain hover:bg-muted flex items-center gap-2"
                      >
                        {session.pinned
                          ? <><PinOff size={12} className="text-textMuted" /> Unpin</>
                          : <><Pin size={12} className="text-textMuted" /> Pin to top</>}
                      </button>
                      <button
                        onClick={() => { setMenuId(null); onDelete?.(uniqueId); }}
                        className="w-full text-left px-3 py-1.5 text-xs text-red-500 hover:bg-muted flex items-center gap-2"
                      >
                        <Trash2 size={12} /> Delete
                      </button>
                    </div>
                  )}
                </div>

                {/* THE action — obvious, always in the same place */}
                <button
                  onClick={() => restoreTabs(session)}
                  title="Reopen every saved tab, window and group from this session"
                  className="ml-1 flex items-center gap-1.5 bg-accent hover:bg-blue-700 dark:hover:bg-blue-300 text-onAccent text-xs font-semibold px-4 py-2 rounded-[10px] shadow-sm transition-colors flex-shrink-0"
                >
                  <RotateCcw size={13} /> Restore
                </button>
              </div>
            </div>

            {/* Expanded: saved links with favicons + group badges */}
            {expandedId === uniqueId && (
              <div className={`dropdown-${uniqueId} mt-3 pt-3 border-t border-borderLight`}>
                <p className="text-xs text-textMuted mb-2 font-medium">Saved links:</p>
                <div className="max-h-[150px] overflow-y-auto space-y-1 custom-scrollbar">
                  {(v1?.windows || []).flatMap(w => w.tabs).map((t, idx) => {
                    const url = t.url;
                    let hostname = '';
                    try {
                      hostname = new URL(url).hostname;
                    } catch (e) {
                      hostname = url.replace(/^https?:\/\//, '').split('/')[0];
                    }
                    // Group badge for links that were grouped
                    const g = t.groupId && (v1.windows.flatMap(w => w.groups || []).find(gg => gg.id === t.groupId));
                    return (
                      <div
                        key={idx}
                        onClick={() => openTab(url)}
                        className="flex items-center gap-2 text-xs text-textMain/80 hover:text-accent hover:bg-muted px-2 py-1 rounded cursor-pointer truncate transition-colors"
                      >
                        <img
                          src={`https://www.google.com/s2/favicons?domain=${hostname || 'google.com'}&sz=16`}
                          className="w-4 h-4 rounded-sm flex-shrink-0"
                          alt=""
                          onError={(e) => e.target.style.display = 'none'}
                        />
                        <span className="truncate">{url}</span>
                        {g && (
                          <span className="ml-auto flex items-center gap-1 flex-shrink-0 pl-1">
                            <span className={`w-1.5 h-1.5 rounded-full ${dotClassFor(g.color)}`} />
                            <span className="text-[10px] text-textMuted flex-shrink-0">{g.title || 'Group'}</span>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>
        );
      })}

      {/* Trash entry — small muted row at the very bottom of the list */}
      {sessions.length > 0 && (
        <button
          onClick={openTrash}
          title="Trash — deleted sessions, restorable for 30 days"
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-textMuted/70 hover:text-accent transition-colors"
        >
          <Trash2 size={12} /> Trash
        </button>
      )}
    </div>
  );
}
