import React, { useEffect, useState } from 'react';
import { X, History, RotateCcw, Loader2, Layers } from 'lucide-react';
import { getVersions, restoreVersion } from '../../../services/api';
import { timeAgo } from '../../utils/sessionStats';

// 🕘 VERSION HISTORY (B7) — server-kept snapshots of a SYNCED session.
// The server archives a snapshot right before every cloud edit (tier depth:
// 3 free / 20 pro), so this list is exactly what exists — no local guess.
// Restoring is a real write: it bumps updatedAt and every other device
// LWW-adopts the restored content on its next sync (the modal says so).
export default function VersionHistoryModal({ session, onClose, onRestored }) {
  const [state, setState] = useState({ loading: true, error: null, versions: [] });
  const [busyId, setBusyId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: null, versions: [] });
    getVersions(session.cloudId)
      .then((r) => {
        if (alive) setState({ loading: false, error: null, versions: Array.isArray(r.data) ? r.data : [] });
      })
      .catch((err) => {
        if (alive) setState({
          loading: false,
          error: err.response?.data?.error || 'Could not load version history.',
          versions: [],
        });
      });
    return () => { alive = false; };
  }, [session.cloudId]);

  const doRestore = async (vid) => {
    if (busyId) return;
    setBusyId(vid);
    try {
      await restoreVersion(session.cloudId, vid);
      // Best-effort immediate pull — the restored copy lands in the local
      // store right away instead of waiting for the next 30s sync alarm.
      try { await chrome.runtime.sendMessage({ type: 'SYNC_NOW' }); } catch { /* alarm will catch up */ }
      onRestored?.();
      onClose();
    } catch (err) {
      setState((s) => ({
        ...s,
        error: err.response?.data?.error || 'Restore failed — please try again.',
      }));
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  };

  return (
    <div
      className="backdrop-in fixed inset-0 z-40 flex items-center justify-center bg-black/50 dark:bg-black/75 p-5"
      onClick={onClose}
    >
      <div
        className="dialog-in bg-primary rounded-2xl border border-borderLight/60 shadow-2xl p-4 w-full max-h-[85%] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-semibold text-textMain text-sm flex items-center gap-1.5">
              <History size={14} className="text-accent" /> Version history
            </h3>
            <p className="text-[11px] text-textMuted mt-0.5 truncate" title={session.name}>{session.name}</p>
          </div>
          <button onClick={onClose} className="icon-btn text-textMuted hover:text-textMain p-1" aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <p className="text-[11px] text-textMuted mt-2 leading-relaxed">
          A snapshot is kept before each cloud edit. Restoring makes the old state
          the new current one — every signed-in device picks it up on its next sync.
        </p>

        {state.error && (
          <p className="text-[11px] text-red-600 dark:text-red-400 mt-2">{state.error}</p>
        )}

        <div className="mt-2 overflow-y-auto flex-1 min-h-0 -mx-1 px-1">
          {state.loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-textMuted">
              <Loader2 size={13} className="animate-spin" /> Loading snapshots…
            </div>
          ) : state.versions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-center">
              <Layers size={20} className="text-textMuted mb-1.5" />
              <p className="text-[11px] text-textMuted leading-relaxed">
                No snapshots yet — one is created automatically<br />before each synced edit of this session.
              </p>
            </div>
          ) : (
            <ul className="space-y-1.5">
              {state.versions.map((v) => (
                <li
                  key={v._id}
                  className="flex items-center justify-between gap-2 p-2 rounded-lg border border-borderLight/60 bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-textMain font-medium">
                      {timeAgo(v.createdAt)}{' '}
                      <span className="text-textMuted font-normal">({v.windows} window{v.windows === 1 ? '' : 's'} · {v.tabs} tab{v.tabs === 1 ? '' : 's'})</span>
                    </p>
                    {confirmId === v._id && (
                      <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                        Restore this version? Current state is kept in history.
                      </p>
                    )}
                  </div>
                  {confirmId === v._id ? (
                    <div className="flex gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => setConfirmId(null)}
                        className="px-2 py-1 rounded-md text-[11px] text-textMuted bg-muted hover:bg-borderLight/60"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => doRestore(v._id)}
                        disabled={busyId === v._id}
                        className="px-2 py-1 rounded-md text-[11px] font-semibold bg-accent text-accentInk hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                      >
                        {busyId === v._id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />} Restore
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmId(v._id)}
                      className="px-2 py-1 rounded-md text-[11px] text-textMain bg-muted hover:bg-borderLight/60 flex items-center gap-1 flex-shrink-0"
                    >
                      <RotateCcw size={11} /> Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
