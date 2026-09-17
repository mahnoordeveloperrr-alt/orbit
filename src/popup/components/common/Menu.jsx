import React from 'react';

/**
 * Popover shared chrome. Renders in the DOM when open; the consumer owns the
 * open/close state, the trigger, and the positioning/sizing classes; this owns
 * the surface, border, shadow, z-order and outside-click dismissal — so "how a
 * popover closes" has one owner.
 * Zero-motion rule (UI redesign): no entrance/exit animation — instant open,
 * and no requestAnimationFrame requirement for test harnesses.
 */
export default function Menu({ open, onClose, className = '', children }) {
  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-20 bg-black/20"
        onClick={onClose}
      />
      <div
        className={`absolute z-30 bg-primary shadow-xl border border-borderLight rounded-xl ${className}`}
      >
        {children}
      </div>
    </>
  );
}
