import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, ChevronUp, Trash2, ArrowLeft, RotateCcw, MoreVertical,
  Pencil, Copy, Download, FolderOpen, Pin, PinOff, Eye, Tag, StickyNote,
  History, Link2
} from 'lucide-react';
import Card from '../common/Card';
import { dotClassFor } from '../../utils/groupColors';
import { boxColorFor } from '../../utils/boxColors';
// 🆕 LOCAL-FIRST: trash/restore/purge operate on chrome.storage.local via store.js
import {
  getTrash, restoreSession, purgeSession, emptyTrash, renameSession,
  duplicateSession, setSessionPinned, setSessionMeta
} from '../../../services/store';
// 🆕 v1 schema — every session is viewed through the locked snapshot shape
import { normalizeSession, sid } from '../../../services/sessionSchema';
// 📊 Card summary line + relative time — "32 tabs · 2 windows · 4 groups", "12 min ago"
import { sessionSummary, timeAgo } from '../../utils/sessionStats';
// 📦 Single-session export (card ⋯ menu)
import { downloadOneSession } from '../../utils/sessionBackup';
// 🆕 V1.5 — metadata editor (tags/folder/note) + restore preview (compare)
import SessionMetaModal from './SessionMetaModal';
import RestorePreviewModal from './RestorePreviewModal';
// 🕘🔗 B5/B7 — share links + server version history (cloud-synced sessions)
import ShareModal from './ShareModal';
import VersionHistoryModal from './VersionHistoryModal';
// 🆕 v1 capture — the preview modal compares the session to the LIVE windows
import { captureAllWindowsV1 } from '../../../services/sessionSchema';

// Trust rule: NEVER rewrite a URL that already carries a scheme —
// chrome://, file://, edge://, ftp:// all open as saved. Only bare hosts
// from very old sessions get https:// prepended.
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const normalizeUrl = (url) => {
  if (!url) return '';
  return HAS_SCHEME.test(url) ? url : 'https://' + url;
};

export default function SessionList({ sessions, onDelete, onRenamed, onRestoreResult, onRestored }) {
  const [expandedId, setExpandedId] = useState(null);
  // 🆕 V1.5 — folders ARE the union of session.folder (no separate store)
  const existingFolders = [...new Set(
    (Array.isArray(sessions) ? sessions : [])
      .map(s => s?.folder)
      .filter(f => typeof f === 'string' && f.trim())
  )].slice(0, 30);
  // 🆕 inline rename — click a session's name or ⋯ → Rename (AUTO card is not renamable)
  const [editingId, setEditingId] = useState(null);
  const [draftName, setDraftName] = useState('');
  // 🆕 three-dot menu — one open at a time; closes on outside click
  const [menuId, setMenuId] = useState(null);
  // Viewport-anchored position, computed once when the menu opens. It is
  // `position: fixed` (NOT absolute inside the card) because the card wears
  // `overflow: hidden` and the list lives in a scroll container — either one
  // would clip an in-card menu (the historical bug this fixes).
  const [menuPos, setMenuPos] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuId) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuId(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuId]);

  // The menu is pinned to the viewport, so a list scroll (or a window resize)
  // would strand it next to a card it no longer belongs to — close it instead.
  useEffect(() => {
    if (!menuId) return;
    const close = () => setMenuId(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
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

  // 🆕 V1.5 — organize (tags/folder/note) + restore-preview dialogs
  const [metaFor, setMetaFor] = useState(null);   // session being organized
  const [previewFor, setPreviewFor] = useState(null); // session being previewed
  // 🕘🔗 B5/B7 — share + version-history dialogs (cloud-synced sessions only)
  const [shareFor, setShareFor] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);
  const [liveWindows, setLiveWindows] = useState(null); // null = compare unavailable

  const handleSaveMeta = async ({ tags, folder, note }) => {
    const uid = sid(metaFor);
    setMetaFor(null);
    try {
      const res = await setSessionMeta(uid, { tags, folder, note });
      if (res?.error === 'not-found') {
        onRestoreResult?.({ kind: 'err', title: "Couldn't organize the session", detail: 'It may have been deleted.' });
        return;
      }
      onRenamed?.(); // reload — chips/note/folder refresh on the card
    } catch (err) {
      console.error('Meta save failed:', err);
      onRestoreResult?.({ kind: 'err', title: "Couldn't organize the session", detail: String(err?.message || err) });
    }
  };

  // 🔎 Preview — capture the LIVE windows once, then let the modal compare.
  // Outside Chrome (dev preview) capture returns [] → modal skips the compare
  // and just shows structure — never blocks the restore itself.
  const openPreview = async (session) => {
    setMenuId(null);
    try {
      const wins = await captureAllWindowsV1();
      setLiveWindows(wins);
    } catch (e) {
      setLiveWindows([]);
    }
    setPreviewFor(session);
  };

  // Soft CLOSE for Saved links (user request): keep the block mounted for
  // 180ms so the collapse-out exit (fade + lift, accelerate curve) can play,
  // then unmount. The functional guards make a fast open-on-another-card
  // safe — the timer can only clear the card it belongs to.
  const [closingId, setClosingId] = useState(null);
  const toggleExpand = (id) => {
    if (expandedId === id) {
      setClosingId(id);
      setTimeout(() => {
        setExpandedId(prev => (prev === id ? null : prev));
        setClosingId(prev => (prev === id ? null : prev));
      }, 180);
    } else {
      setExpandedId(id);
    }
  };

  // Seven rows + padding ≈ 230px; keep slack so the last item never sits on
  // the popup edge. Flip UP only when the room below is genuinely smaller
  // than the menu AND the room above is the better of the two — measured in
  // the real viewport, then written as fixed coordinates.
  const MENU_H = 230;
  const toggleMenu = (id, e) => {
    if (menuId === id) { setMenuId(null); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 560;
    const vw = (typeof document !== 'undefined' && document.documentElement.clientWidth) || 420;
    const roomBelow = vh - rect.bottom;
    const roomAbove = rect.top;
    const openUp = roomBelow < MENU_H && roomAbove >= roomBelow;
    setMenuPos({
      right: Math.max(0, Math.round(vw - rect.right)),
      ...(openUp
        ? { bottom: Math.round(vh - rect.top + 6) }   // grows upward from above the button
        : { top: Math.round(Math.min(rect.bottom + 6, vh - MENU_H)) })
    });
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
      <div className="view-enter space-y-3 mt-4">
        <div className="flex items-center justify-between px-2 py-2 text-xs text-textMuted border-b border-borderLight/50 pb-2">
          <button
            onClick={() => setShowTrash(false)}
            className="flex items-center gap-1 hover:text-textMain font-medium transition-colors"
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
          trashItems.map((session, i) => {
            const uid = sid(session);
            return (
              <Card key={uid} className="session-card p-4 rise" color="orange" style={{ '--d': `${Math.min(i, 6) * 50}ms` }}>
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
                      className="flex items-center gap-1 text-box-orange hover:brightness-110 text-sm font-medium px-2"
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
      {sessions.map((session, i) => {
        const uniqueId = sid(session);
        const v1 = normalizeSession(session); // 🆕 v1 view (also covers legacy docs)
        const boxColor = boxColorFor(i); // this card's color — chip AND button share it
        // Fill + ink for the Restore pill and the meta chip are owned by CSS
        // (--hue-fill / --hue-ink, published by this card's box-* class): pink
        // and amber wear dark ink on their fill, dark-mode blue flips to white
        // (#0019FB is too dark for dark ink) — and the light theme swaps both
        // for its measured pastels in ONE place (see the LIGHT MODE section).
        // NB: no overflow-hidden on this card — it clipped the card's ⋯ dropdown menu
        // Soft staggered entrance (Material decelerate): first card leads at
        // 280ms (after header/CTA), each next +55ms, capped at 8 steps so long
        // lists never feel like a slideshow.
        return (
          <Card
            key={uniqueId}
            className={`session-card session-card-${uniqueId} p-3.5 rise`}
            color={boxColor}
            style={{ '--d': `${Math.min(i, 8) * 55 + 280}ms` }}
          >
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
                        className={`font-medium text-textMain text-sm truncate ${session.isAutoSave ? '' : 'cursor-text hover:text-textMain'}`}
                      >
                        {session.name}
                      </h4>
                    )}
                    {/* AUTO badge — maintained by the background auto-save worker.
                        Gold (special state color): system-managed, not a user session. */}
                    {session.isAutoSave && (
                      <span className="text-[10px] font-bold text-[rgb(var(--box-yellow))] bg-[rgb(var(--box-yellow)/0.1)] border border-[rgb(var(--box-yellow)/0.3)] px-1.5 py-0.5 rounded-full flex-shrink-0">
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

                  {/* Summary line — "32 tabs · 2 windows · 4 groups" + "Saved 12 min ago".
                     The time wears the card's color as a chip (ui/ reference:
                     small bright pills on the deep-dark box). */}
                  <div className="flex items-center gap-1.5 text-textMuted text-xs mt-0.5">
                    <span>{sessionSummary(session)}</span>
                    <span>·</span>
                    {/* `.saved-chip` = hue pill in dark, plain grey text in light (mock) */}
                    <span className="saved-chip text-[10px] font-semibold px-1.5 py-px rounded-full border">
                      Saved {timeAgo(session.createdAt)}
                    </span>
                  </div>

                  {/* 🆕 V1.5 metadata — folder badge, tag chips, note preview */}
                  {((v1?.tags || []).length > 0 || v1?.folder || v1?.note) && (
                    <div className="flex flex-wrap items-center gap-1 mt-1.5">
                      {v1.folder && (
                        <span className="flex items-center gap-1 bg-muted text-textMain text-[10px] font-medium px-1.5 py-0.5 rounded-full border border-borderLight/50">
                          <FolderOpen size={9} className="text-textMuted" /> {v1.folder}
                        </span>
                      )}
                      {(v1.tags || []).slice(0, 4).map(t => (
                        <span key={t} className="bg-muted text-textMuted text-[10px] px-1.5 py-0.5 rounded-full border border-borderLight/50">
                          #{t}
                        </span>
                      ))}
                      {(v1.tags || []).length > 4 && (
                        <span className="text-[10px] text-textMuted">+{v1.tags.length - 4}</span>
                      )}
                      {v1.note && (
                        <span
                          title={v1.note}
                          className="flex items-center gap-1 text-[10px] text-textMuted italic truncate max-w-[150px]"
                        >
                          <StickyNote size={9} className="flex-shrink-0" /> {v1.note}
                        </span>
                      )}
                    </div>
                  )}

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
                  className="icon-btn text-textMuted hover:text-textMain p-1.5"
                >
                  {expandedId === uniqueId ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>

                {/* Three-dot menu — Rename · Duplicate · Export · Delete */}
                <div className="relative">
                  <button
                    onClick={(e) => toggleMenu(uniqueId, e)}
                    title="More actions"
                    className="icon-btn text-textMuted hover:text-textMain p-1.5"
                  >
                    <MoreVertical size={15} />
                  </button>
                  {/* ui/ "drop-down page" mock: panel styling (glow + inner
                      shadow) lives in .card-menu; item ORDER mirrors the
                      reference — Rename · Pin · Delete · Duplicate · Export */}
                  {menuId === uniqueId && (
                    <div
                      ref={menuRef}
                      style={menuPos}
                      className="card-menu menu-in fixed z-30 w-40 rounded-[12px] py-1"
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
                        onClick={() => handleTogglePin(session)}
                        className="w-full text-left px-3 py-1.5 text-xs text-textMain hover:bg-muted flex items-center gap-2"
                      >
                        {session.pinned
                          ? <><PinOff size={12} className="text-textMuted" /> Unpin</>
                          : <><Pin size={12} className="text-textMuted" /> Pin to top</>}
                      </button>
                      {/* 🆕 V1.5 — Preview (compare before restore) */}
                      <button
                        onClick={() => openPreview(session)}
                        className="w-full text-left px-3 py-1.5 text-xs text-textMain hover:bg-muted flex items-center gap-2"
                      >
                        <Eye size={12} className="text-textMuted" /> Preview
                      </button>
                      {/* 🆕 V1.5 — Organize (tags / folder / note) */}
                      <button
                        onClick={() => { setMenuId(null); setMetaFor(session); }}
                        className="w-full text-left px-3 py-1.5 text-xs text-textMain hover:bg-muted flex items-center gap-2"
                      >
                        <Tag size={12} className="text-textMuted" /> Organize…
                      </button>
                      {/* 🕘 B7 — server version history (cloud-synced sessions) */}
                      {session.cloudId && !session.isAutoSave && (
                        <button
                          onClick={() => { setMenuId(null); setHistoryFor(session); }}
                          className="w-full text-left px-3 py-1.5 text-xs text-textMain hover:bg-muted flex items-center gap-2"
                        >
                          <History size={12} className="text-textMuted" /> History…
                        </button>
                      )}
                      {/* 🔗 B5 — 30-day share link (snapshot; claimer's import is quota-checked) */}
                      {session.cloudId && (
                        <button
                          onClick={() => { setMenuId(null); setShareFor(session); }}
                          className="w-full text-left px-3 py-1.5 text-xs text-textMain hover:bg-muted flex items-center gap-2"
                        >
                          <Link2 size={12} className="text-textMuted" /> Share…
                        </button>
                      )}
                      <button
                        onClick={() => { setMenuId(null); onDelete?.(uniqueId); }}
                        className="w-full text-left px-3 py-1.5 text-xs text-red-500 hover:bg-muted flex items-center gap-2"
                      >
                        <Trash2 size={12} /> Delete
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
                    </div>
                  )}
                </div>

                  {/* THE action — obvious, always in the same place.
                     Wears THIS card's hue: bar, border AND button share it
                     (user spec — restore matches the colored tab bar);
                     dark ink on the fill, hover deepens like the neon CTA. */}
                <button
                  onClick={() => restoreTabs(session)}
                  title="Reopen every saved tab, window and group from this session"
                  className="restore-btn ml-1 flex items-center gap-1.5 hover:brightness-90 text-xs font-semibold px-4 py-2 rounded-[10px] transition-all flex-shrink-0"
                >
                  <RotateCcw size={13} /> Restore
                </button>
              </div>
            </div>

            {/* Expanded: saved links with favicons + group badges */}
            {(expandedId === uniqueId || closingId === uniqueId) && (
              <div className={`dropdown-${uniqueId} ${closingId === uniqueId ? 'collapse-out' : 'fade-in'} mt-3 pt-3 border-t border-borderLight`}>
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
                    // SLOW soft reveal (user request): each link waits
                    // +90ms so tabs appear one-by-one in a gentle cascade
                    // (~1.1s to the 12th row, later rows share the cap so a
                    // 50-tab session never turns into a slideshow). The
                    // container's .fade-in covers the border/label first.
                    return (
                      <div
                        key={idx}
                        onClick={() => openTab(url)}
                        className="rise flex items-center gap-2 text-xs text-textMain/80 hover:text-textMain hover:bg-muted px-2 py-1 rounded cursor-pointer truncate transition-colors"
                        style={{ '--d': `${Math.min(idx, 12) * 90}ms` }}
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

      {/* 🆕 V1.5 dialogs — organize (tags/folder/note) + restore preview */}
      <SessionMetaModal
        open={!!metaFor}
        session={metaFor}
        existingFolders={existingFolders}
        onSave={handleSaveMeta}
        onCancel={() => setMetaFor(null)}
      />
      <RestorePreviewModal
        open={!!previewFor}
        session={previewFor}
        liveWindows={liveWindows}
        onRestore={(v1Session) => {
          setPreviewFor(null);
          restoreTabs(v1Session);
        }}
        onCancel={() => setPreviewFor(null)}
      />
      {/* 🔗 B5 — share-link dialog (mints a 30-day snapshot link) */}
      {shareFor && (
        <ShareModal session={shareFor} onClose={() => setShareFor(null)} />
      )}
      {/* 🕘 B7 — version-history dialog (list + tier-pruned restore) */}
      {historyFor && (
        <VersionHistoryModal
          session={historyFor}
          onClose={() => setHistoryFor(null)}
          onRestored={() => { setHistoryFor(null); onRestored?.(); }}
        />
      )}

      {/* Trash entry — orange accent panel (spec: orange = recovery/warning);
         flat surface, thin border, compact one-row design */}
      {sessions.length > 0 && (
        <button
          onClick={openTrash}
          title="Trash — deleted sessions, restorable for 30 days"
          className="w-full mt-2 flex items-center gap-2 surface box-orange rounded-[14px] border p-2.5 text-left hover:-translate-y-px hover:border-[rgb(var(--box-orange))] transition-all"
        >
          <Trash2 size={13} className="flex-shrink-0 text-box-orange" />
          <span className="text-xs font-semibold text-textMain">Trash</span>
          <span className="ml-auto text-[10px] text-textMuted">Deleted sessions · restorable 30 days</span>
        </button>
      )}
    </div>
  );
}
