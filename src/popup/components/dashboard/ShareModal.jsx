import React, { useEffect, useRef, useState } from 'react';
import { Link2, Copy, Check, X, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { shareSession } from '../../../services/api';

// 🔗 SHARE (B5) — mint a 30-day link for a SYNCED session. The link carries a
// frozen SNAPSHOT: importing never touches your copy, and the claimer's
// import runs through the same quota + dedupe rules as any other create.
// Re-sharing rotates the token (the old link dies immediately).
export default function ShareModal({ session, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, share: null });
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  // Re-entrancy guard kept OUT of state on purpose: `busy` must never change
  // the effect's dependencies, or mint→setBusy→effect→mint would loop.
  const minting = useRef(false);

  const mint = async () => {
    if (minting.current) return;
    minting.current = true;
    setBusy(true);
    setState({ loading: true, error: null, share: null });
    try {
      const r = await shareSession(session.cloudId);
      setState({ loading: false, error: null, share: r.data });
      setCopied(false);
    } catch (err) {
      setState({
        loading: false,
        error: err.response?.data?.error || 'Could not create a share link.',
        share: null,
      });
    } finally {
      minting.current = false;
      setBusy(false);
    }
  };

  // Mint once per opened session (manual re-mint goes through the button).
  useEffect(() => { mint(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [session.cloudId]);

  const link = state.share?.url || (state.share?.token ? `token: ${state.share.token}` : '');

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(state.share?.url || state.share?.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — the field is selectable */
    }
  };

  return (
    <div
      className="backdrop-in fixed inset-0 z-40 flex items-center justify-center bg-black/50 dark:bg-black/75 p-5"
      onClick={onClose}
    >
      <div
        className="dialog-in bg-primary rounded-2xl border border-borderLight/60 shadow-2xl p-4 w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-textMain text-sm flex items-center gap-1.5">
            <Link2 size={14} className="text-accent" /> Share session
          </h3>
          <button onClick={onClose} className="icon-btn text-textMuted hover:text-textMain p-1" aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <p className="text-[11px] text-textMuted mt-1 truncate" title={session.name}>{session.name}</p>

        {state.loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-textMuted">
            <Loader2 size={13} className="animate-spin" /> Creating link…
          </div>
        ) : state.error ? (
          <div>
            <p className="text-[11px] text-red-600 dark:text-red-400 mt-3">{state.error}</p>
            <button
              onClick={mint}
              className="mt-3 px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-textMain hover:bg-borderLight/60 flex items-center gap-1.5"
            >
              <RefreshCw size={12} /> Try again
            </button>
          </div>
        ) : (
          <>
            <div className="flex gap-2 mt-3">
              <input
                readOnly
                value={link}
                onFocus={(e) => e.target.select()}
                className="flex-1 min-w-0 text-xs text-textMain bg-muted border border-borderLight/60 rounded-lg px-2.5 py-2 font-mono"
              />
              <button
                onClick={copy}
                className="px-3 py-2 rounded-lg text-xs font-semibold bg-accent text-accentInk hover:opacity-90 flex items-center gap-1.5 flex-shrink-0"
              >
                {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
              </button>
            </div>
            <p className="text-[11px] text-textMuted mt-2 leading-relaxed flex items-start gap-1.5">
              <ShieldCheck size={13} className="flex-shrink-0 mt-px text-emerald-500" />
              <span>
                Snapshot link — expires {state.share?.expiresAt ? `in ${Math.max(1, Math.ceil((new Date(state.share.expiresAt) - Date.now()) / 86400000))} days` : 'in 30 days'}.
                Anyone with the link can import a copy into their own Orbitabs; it can never change or delete yours.
              </span>
            </p>
            <button
              onClick={mint}
              disabled={busy}
              className="mt-3 px-3 py-1.5 rounded-md text-[11px] font-medium bg-muted text-textMuted hover:bg-borderLight/60 hover:text-textMain flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw size={11} className={busy ? 'animate-spin' : ''} /> New link (revokes the old one)
            </button>
          </>
        )}
      </div>
    </div>
  );
}
