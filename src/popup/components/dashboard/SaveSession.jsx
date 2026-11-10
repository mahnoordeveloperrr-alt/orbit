import React from 'react';
import { Plus, Layers } from 'lucide-react';
import Button from '../common/Button';

// Naming is handled elsewhere: "Save" always auto-generates the session name
// ("Session — Sep 8, 2026 — 10:32 PM"); rename later from the session list.
// Scope toggle sits where the old name input used to be (user layout):
// all windows ↔ current window, so the save row shows scope + Save only.
// `compact` renders a slimmer row for the Dashboard status line.
// Uniform trio: scope toggle, Save and the auto-save button all share one
// fixed size (w-[110px] h-7) so the status row reads as a centered triplet.
export default function SaveSession({ onSave, scope = 'all', onScopeChange, compact = false, variant = 'primary', disabled = false }) {
  const handleSave = () => {
    onSave(''); // Dashboard generates the auto-name
  };

  return (
    <div className={`flex ${compact ? 'gap-1.5' : 'gap-2'}`}>
      {onScopeChange && (
        <button
          onClick={() => onScopeChange(scope === 'all' ? 'window' : 'all')}
          title={scope === 'all' ? 'Save EVERY open window — click to switch to the current window only' : 'Save ONLY the window you are in — click to switch to all windows'}
          className={`scope-btn flex items-center justify-center gap-1 w-[110px] h-7 rounded-[10px] text-xs font-medium border transition-colors flex-shrink-0 ${scope === 'all'
            ? 'bg-zinc-100 dark:bg-zinc-800/60 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700/50'
            : 'bg-muted text-textMuted border-borderLight/60 hover:text-textMain'}`}
        >
          <Layers size={12} />
          {scope === 'all' ? 'All windows' : 'Current window'}
        </button>
      )}
      <Button variant={variant} onClick={handleSave} disabled={disabled} className={`save-mini ${compact ? 'w-[110px] h-7 !text-xs' : ''} flex items-center gap-1 flex-shrink-0`}>
        <Plus className="w-4 h-4" /> Save
      </Button>
    </div>
  );
}
