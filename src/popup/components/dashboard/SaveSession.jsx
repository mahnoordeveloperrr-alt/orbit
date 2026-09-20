import React, { useState } from 'react';
import { Plus, Layers } from 'lucide-react';
import Button from '../common/Button';
import Input from '../common/Input';

// Task 2: session name is OPTIONAL. "Save" with an empty name auto-generates
// one ("Session — Sep 8, 2026 — 10:32 PM"); rename later anytime.
// Scope toggle: save all windows (default) or just the current one.
// `compact` renders a slimmer row for the Dashboard status line.
export default function SaveSession({ onSave, scope = 'all', onScopeChange, compact = false }) {
  const [name, setName] = useState('');

  const handleSave = () => {
    onSave(name); // empty is fine — Dashboard generates the auto-name
    setName('');
  };

  return (
    <div className={`flex ${compact ? 'gap-1.5' : 'gap-2'} flex-1 min-w-0`}>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
        placeholder="Session name (optional)"
        className="flex-1 min-w-0"
      />
      {onScopeChange && (
        <button
          onClick={() => onScopeChange(scope === 'all' ? 'window' : 'all')}
          title={scope === 'all' ? 'Save EVERY open window — click to switch to the current window only' : 'Save ONLY the window you are in — click to switch to all windows'}
          className={`flex items-center gap-1 px-2.5 rounded-[10px] text-xs font-medium border transition-colors flex-shrink-0 ${scope === 'all'
            ? 'bg-violet-100 dark:bg-violet-950/60 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800 hover:bg-violet-200 dark:hover:bg-violet-900/50'
            : 'bg-muted text-textMuted border-borderLight/60 hover:text-textMain'}`}
        >
          <Layers size={12} />
          {scope === 'all' ? 'All windows' : 'Current window'}
        </button>
      )}
      <Button onClick={handleSave} className={`${compact ? 'px-3 py-1.5 text-xs' : ''} flex items-center gap-1 flex-shrink-0`}>
        <Plus className="w-4 h-4" /> Save
      </Button>
    </div>
  );
}
