import React from 'react';
import { AlertTriangle } from 'lucide-react';

// Task 11: every destructive action gets a real dialog — never instant loss.
// Confirm copy follows the spec: "Delete session? [Cancel] [Move to Trash]".
// Zero-motion rule (UI redesign): no entrance/exit animation — the dialog must
// feel instant, and the component must not require requestAnimationFrame in
// test harnesses.
export default function ConfirmModal({
  open, title, message,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, onConfirm, onCancel
}) {
  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center p-6"
      style={{ background: 'rgba(15, 23, 42, 0.45)' }}
      onClick={onCancel}
    >
      <div
        className="bg-primary rounded-2xl border border-borderLight/60 shadow-2xl p-5 w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded-full flex-shrink-0 ${danger ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
            <AlertTriangle size={18} />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-textMain text-sm">{title}</h3>
            <p className="text-xs text-textMuted mt-1 leading-relaxed whitespace-pre-line">{message}</p>
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button
            onClick={onCancel}
            className="flex-1 px-3 py-2 rounded-lg text-sm font-medium text-textMuted bg-muted hover:bg-borderLight/60 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-semibold text-white transition-colors shadow-sm ${danger ? 'bg-red-500 hover:bg-red-600' : 'bg-accent hover:bg-indigo-600'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
