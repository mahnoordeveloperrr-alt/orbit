import React, { useState, useEffect } from 'react';
import { RotateCcw, Clock } from 'lucide-react';

/**
 * 🆕 Crash Recovery Banner (Task 7) — reads the recoveryCandidate the background
 * worker queues when it detects an abnormal shutdown, offers Restore/Dismiss.
 * Owns the check, the banner UI, and both worker messages; Dashboard just mounts it.
 * Zero animation by design: a crash banner must appear INSTANTLY.
 */
export default function RecoveryBanner() {
  const [recovery, setRecovery] = useState(null); // { count, savedAt }

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    chrome.storage.local.get(['recoveryCandidate', 'crashDetectedAt']).then(({ recoveryCandidate, crashDetectedAt }) => {
      if (recoveryCandidate) {
        const count = (recoveryCandidate.windows || []).reduce((n, w) => n + (w.tabs?.length || 0), 0);
        const savedAt = recoveryCandidate.savedAt;
        setRecovery({ count, savedAt, crashDetectedAt });
      }
    });
  }, []);

  // Restore the crashed session via the background service worker
  const handleRestore = async () => {
    setRecovery(null);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'RESTORE_RECOVERY' });
      if (!res?.ok) console.error('Recovery restore failed:', res);
    } catch (err) { console.error('Recovery restore failed:', err); }
  };

  // Dismiss the banner (clears badge + candidate)
  const handleDismiss = async () => {
    setRecovery(null);
    try { await chrome.runtime.sendMessage({ type: 'DISMISS_RECOVERY' }); } catch (err) { console.error(err); }
  };

  if (!recovery) return null;

  // Format the time since last save
  const getTimeAgo = (timestamp) => {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) return `${minutes}m ago`;
    return `${seconds}s ago`;
  };

  return (
    /* ui/ reference "crash" strip — the SAME trapped inner-shadow recipe the
       session cards and Settings sections wear, in this banner's semantic
       colour: yellow/gold = recovery (boxColors.js §20). `.box-yellow`
       publishes --card-hue (glow yellow); `.inner-glow-section` supplies the
       flat #18181c interior (dark in BOTH modes) + hue glow ×2 + dark lip.
       Tests pin the strings "Chrome crashed" and "Not now" — keep them. */
    <div className="w-full box-yellow inner-glow-section rounded-xl p-3 mb-3 relative z-10 flex items-center justify-between gap-2">
      {/* LEFT must be allowed to shrink (default flex-shrink:1 + min-w-0) so
          the long title wraps instead of pushing the banner wider than the
          popup — both columns shrink-0 measured 438px of content in a 379px
          card (horizontal overflow). Buttons on the right stay flex-shrink-0. */}
      <div className="flex flex-col min-w-0">
        <span className="text-textMain text-sm font-semibold flex items-center gap-1.5">
          <RotateCcw size={15} className="text-[rgb(var(--box-yellow))] flex-shrink-0" />
          Chrome crashed — restore {recovery.count} tabs?
        </span>
        {recovery.savedAt && (
          <span className="text-textMuted text-xs flex items-center gap-1 mt-0.5">
            <Clock size={10} /> Last saved {getTimeAgo(recovery.savedAt)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={handleDismiss}
          className="text-textMuted hover:text-textMain text-xs font-medium underline underline-offset-2"
        >
          Not now
        </button>
        <button
          onClick={handleRestore}
          title="Reopen the tabs that were open before the crash"
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-[10px] text-xs font-semibold transition-all hover:brightness-90"
          style={{
            backgroundColor: 'rgb(var(--box-yellow))',
            color: 'rgb(var(--c-accent-ink))', /* dark ink on the gold fill — session-card convention */
            boxShadow: 'inset 0 0 15px rgba(0, 0, 0, 0.25)',
          }}
        >
          <RotateCcw size={13} /> Restore tabs
        </button>
      </div>
    </div>
  );
}
