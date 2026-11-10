import React from 'react';
import { AlertTriangle, X, Check, Trash2 } from 'lucide-react';

// Task 11: every destructive action gets a real dialog — never instant loss.
// Confirm copy follows the spec: "Delete session? [Cancel] [Move to Trash]".
// Motion (soft Google/Material pass): backdrop fades in, the panel scales in
// on the emphasized curve (240ms) via CSS classes only — no JS animation, no
// requestAnimationFrame, so test harnesses stay unaffected (the dialog is
// fully rendered on the first frame; the animation is pure presentation).
export default function ConfirmModal({
  open, title, message,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, onConfirm, onCancel
}) {
  if (!open) return null;

  return (
    <div
      className="backdrop-in fixed inset-0 z-40 flex items-center justify-center bg-black/50 dark:bg-black/75 p-6"
      onClick={onCancel}
    >
      <div
        className="dialog-in bg-primary rounded-2xl border border-borderLight/60 shadow-2xl p-5 w-full"
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
            className="flex-1 px-3 py-2 rounded-lg text-sm font-medium text-textMuted bg-muted hover:bg-borderLight/60 transition-colors flex items-center justify-center gap-1.5"
          >
            <X size={13} /> {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-semibold text-white transition-colors shadow-sm flex items-center justify-center gap-1.5 ${
              danger ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-accent text-accentInk hover:bg-accentDark'
            }`}
          >
            {danger ? <Trash2 size={13} /> : <Check size={13} />} {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
