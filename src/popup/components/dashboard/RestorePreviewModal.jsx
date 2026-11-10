import React, { useState, useEffect } from 'react';
import { X, RotateCcw, AppWindow, Layers, CircleDot } from 'lucide-react';
import { normalizeSession } from '../../../services/sessionSchema';
import { dotClassFor } from '../../utils/groupColors';

// 🔎 RESTORE PREVIEW (V1.5) — "what am I about to reopen?" before committing.
// Shows the session's real structure (windows → groups → tabs) and an honest
// compare against what's currently open: how many saved tabs are ALREADY open
// (restoring will duplicate them) vs how many are new. Chrome's restore is
// additive by design — this preview says so out loud instead of surprising
// the user with doubles.
//
// The compare source is passed in (Dashboard captures the live windows); this
// component never touches Chrome APIs itself, so it stays test-mountable.
export default function RestorePreviewModal({ open, session, liveWindows, onRestore, onCancel }) {
  const [v1, setV1] = useState(null);
  const [already, setAlready] = useState(new Set());

  useEffect(() => {
    if (!open || !session) return;
    const norm = normalizeSession(session);
    setV1(norm);
    // Compare by URL (normalized: lowercase, no trailing slash) — the same
    // page re-opened from history counts as "already open".
    const live = new Set();
    (Array.isArray(liveWindows) ? liveWindows : []).forEach(w => {
      (w?.tabs || []).forEach(t => {
        const u = String(t?.url || '').trim().toLowerCase().replace(/\/+$/, '');
        if (u) live.add(u);
      });
    });
    const openSet = new Set();
    (norm?.windows || []).forEach(w => (w.tabs || []).forEach(t => {
      const u = String(t.url || '').trim().toLowerCase().replace(/\/+$/, '');
      if (u && live.has(u)) openSet.add(u);
    }));
    setAlready(openSet);
  }, [open, session, liveWindows]);

  if (!open || !v1) return null;

  const allTabs = v1.windows.flatMap(w => w.tabs);
  const newCount = allTabs.filter(t => {
    const u = String(t.url || '').trim().toLowerCase().replace(/\/+$/, '');
    return u && !already.has(u);
  }).length;
  const groupCount = v1.windows.reduce((n, w) => n + (w.groups || []).length, 0);
  const canCompare = Array.isArray(liveWindows) && liveWindows.length > 0;

  return (
    // FIXED (not absolute): same card-menu lesson — inside the scrolling
    // session list, only viewport-fixed survives overflow-hidden ancestors.
    <div
      className="backdrop-in fixed inset-0 z-40 flex items-center justify-center bg-black/50 dark:bg-black/75 p-5"
      onClick={onCancel}
    >
      <div
        className="dialog-in bg-primary rounded-2xl border border-borderLight/60 shadow-2xl p-4 w-full max-h-[440px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-semibold text-textMain text-sm truncate pr-2">{v1.name}</h3>
          <button onClick={onCancel} title="Close" className="icon-btn text-textMuted hover:text-textMain p-1 flex-shrink-0">
            <X size={15} />
          </button>
        </div>

        {/* Summary strip — the numbers that matter before committing */}
        <div className="flex items-center gap-2 text-[11px] text-textMuted mb-2 flex-wrap">
          <span className="flex items-center gap-1"><AppWindow size={11} /> {v1.windows.length} window{v1.windows.length === 1 ? '' : 's'}</span>
          <span>·</span>
          <span>{allTabs.length} tab{allTabs.length === 1 ? '' : 's'}</span>
          {groupCount > 0 && (<><span>·</span><span className="flex items-center gap-1"><Layers size={11} /> {groupCount} group{groupCount === 1 ? '' : 's'}</span></>)}
          {v1.windows.some(w => w.tabs.some(t => t.pinned)) && (<><span>·</span><span>{v1.windows.flatMap(w => w.tabs).filter(t => t.pinned).length} pinned</span></>)}
        </div>

        {/* Honest compare — restoration is additive; say it before they click */}
        {canCompare && (
          <div className={`text-[11px] px-2.5 py-1.5 rounded-lg border mb-2 ${already.size > 0
            ? 'bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300'
            : 'bg-muted border-borderLight/60 text-textMuted'}`}>
            {already.size > 0
              ? `${already.size} of these ${allTabs.length} tabs are already open — restoring adds the rest (Chrome never closes your current tabs).`
              : canCompare
                ? `None of these tabs are open right now — restore will open ${allTabs.length} tab${allTabs.length === 1 ? '' : 's'}.`
                : ''}
          </div>
        )}

        {/* Structure — windows → groups → tabs, scrollable */}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-2 pr-1">
          {v1.windows.map((w, wi) => (
            <div key={wi} className="surface border border-borderLight/60 rounded-xl p-2.5">
              <p className="text-[10px] font-semibold tracking-wider uppercase text-textMuted mb-1.5">
                Window {wi + 1}{w.focused ? ' · focused' : ''} — {w.tabs.length} tab{w.tabs.length === 1 ? '' : 's'}
              </p>
              {(w.groups || []).length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {w.groups.map(g => (
                    <span key={g.id} className="flex items-center gap-1 bg-muted text-textMuted text-[10px] px-1.5 py-0.5 rounded-full border border-borderLight/50">
                      <span className={`w-1.5 h-1.5 rounded-full ${dotClassFor(g.color)}`} />
                      <span className="font-medium">{g.title || 'Group'}</span>
                      <span>{w.tabs.filter(t => t.groupId === g.id).length}</span>
                    </span>
                  ))}
                </div>
              )}
              <div className="space-y-0.5 max-h-[120px] overflow-y-auto custom-scrollbar">
                {w.tabs.map((t, ti) => {
                  const u = String(t.url || '').trim().toLowerCase().replace(/\/+$/, '');
                  const isOpen = u && already.has(u);
                  const g = t.groupId && (w.groups || []).find(gg => gg.id === t.groupId);
                  return (
                    <div key={ti} className="flex items-center gap-1.5 text-[11px] text-textMain/80 px-1.5 py-0.5 rounded">
                      {g && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClassFor(g.color)}`} />}
                      <CircleDot size={9} className={`flex-shrink-0 ${t.pinned ? 'text-amber-500' : 'text-textMuted/50'}`} />
                      <span className="truncate flex-1">{t.title || t.url}</span>
                      {t.pinned && <span className="text-[9px] text-amber-500 flex-shrink-0">pinned</span>}
                      {isOpen && canCompare && <span className="text-[9px] text-green-600 dark:text-green-400 flex-shrink-0">open</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-2 mt-3">
          <button
            onClick={onCancel}
            className="flex-1 px-3 py-2 rounded-lg text-sm font-medium text-textMuted bg-muted hover:bg-borderLight/60 transition-colors flex items-center justify-center gap-1.5"
          >
            <X size={13} /> Cancel
          </button>
          <button
            onClick={() => onRestore?.(v1)}
            className="flex-1 px-3 py-2 rounded-lg text-sm font-semibold bg-accent text-accentInk hover:bg-accentDark transition-colors shadow-sm flex items-center justify-center gap-1.5"
          >
            <RotateCcw size={13} /> Restore {allTabs.length} tab{allTabs.length === 1 ? '' : 's'}
            {newCount < allTabs.length ? ` (${newCount} new)` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
