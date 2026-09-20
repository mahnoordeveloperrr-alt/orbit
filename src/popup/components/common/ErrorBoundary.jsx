import React from 'react';
import { AlertTriangle } from 'lucide-react';
import RecoveryBanner from '../dashboard/RecoveryBanner';

/**
 * 🛡️ Error boundary — a crash in ANY component can never blank the popup.
 *
 * Class components are the only place React exposes error boundaries
 * (getDerivedStateFromError / componentDidCatch) — there is no hook
 * equivalent, which is why this file is a class in an otherwise
 * function-component codebase.
 *
 * Two modes:
 *  - `emergency` (root, see main.jsx): renders a self-contained fallback that
 *    ALSO mounts a guarded RecoveryBanner, so the one screen a stranger needs
 *    right after a Chrome crash — session recovery — stays reachable even
 *    while the rest of the app is down. "Try again" re-renders the tree.
 *  - default (nested): fails SILENTLY (null) so one broken widget can never
 *    take its siblings down.
 *
 * The fallback is deliberately static — it renders nothing that reads store
 * state, so the crash cause itself cannot re-crash this screen.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Console-only diagnostics — no network calls, matching the extension's
    // no-analytics guarantee. componentStack points at the culprit component.
    console.error(`[Orbitabs] UI crashed inside ${this.props.label || 'popup'}:`, error, info?.componentStack);
  }

  handleReset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Nested widgets fail silently — isolation, not an emergency.
    if (!this.props.emergency) return null;

    return (
      <div className="w-full h-full flex flex-col items-center justify-center p-6 bg-gradient-to-br from-violet-50 via-violet-100 to-violet-200 dark:from-slate-900 dark:via-slate-900 dark:to-slate-800">
        <div className="bg-primary/80 border border-amber-500/30 rounded-2xl p-5 max-w-[340px] text-center shadow-premium">
          <AlertTriangle size={28} className="text-amber-500 mx-auto mb-2" />
          <h1 className="text-base font-bold text-violet-800 dark:text-slate-100 mb-1">Orbitabs hit a snag</h1>
          <p className="text-xs text-textMuted mb-4">
            This screen failed to render. Your saved sessions are safe — they live
            in Chrome&apos;s local storage, not in this window.
          </p>

          {/* Recovery stays offered even while the app is down — guarded by its
              own boundary so IT can never re-crash this fallback. */}
          <ErrorBoundary>
            <RecoveryBanner />
          </ErrorBoundary>

          <button
            onClick={this.handleReset}
            className="bg-violet-600 hover:bg-violet-700 text-white font-semibold text-sm px-4 py-1.5 rounded-full shadow-md transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
