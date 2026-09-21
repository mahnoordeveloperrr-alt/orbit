import React from 'react';
import { BOX_GRADIENTS } from '../../utils/boxColors';

// Flat, professional button system. Hover = color change only (no movement),
// per the zero-motion design rule. Disabled = dimmed + blocked cursor.
// Focus ring for keyboard users; dark-mode hover LIGHTENS the accent (the
// dark accent is light blue — darkening it would kill text contrast).
export default function Button({ children, onClick, variant = 'primary', className = '', title, disabled, color }) {
  const baseStyle = "px-4 py-2 rounded-[10px] font-semibold text-sm transition-colors duration-150 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";
  // Primary = blue (the hero accent). `color` recolors the action to one of
  // the box colors — same gradients the cards use (BOX_GRADIENTS, one owner).
  const variants = {
    primary: color && BOX_GRADIENTS[color]
      ? `bg-gradient-to-b text-white shadow-md ${BOX_GRADIENTS[color]}`
      : "bg-accent text-onAccent hover:brightness-110 shadow-md shadow-blue-900/30",
    outline: "border border-borderLight text-textMain hover:bg-muted hover:border-accent hover:text-accent",
    danger: "bg-red-500 text-white hover:bg-red-600 shadow-sm",
    ghost: "text-textMuted hover:text-accent hover:bg-accent/10",
  };
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`${baseStyle} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
