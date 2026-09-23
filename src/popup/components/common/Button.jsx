import React from 'react';

// Flat button system per the production spec — solid fills, 100-150ms
// color transitions only (no movement, no gradients). Neon green is the
// primary action color; dark ink text keeps contrast on neon fills.
// Focus ring for keyboard users (accessibility: visible focus states).
export default function Button({ children, onClick, variant = 'primary', className = '', title, disabled }) {
  const baseStyle = "px-4 py-2 rounded-[10px] font-semibold text-sm transition-colors duration-150 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";
  const variants = {
    // PRIMARY = Orbitabs green + dark ink (neon is accent, dark text for AA)
    primary: "bg-accent text-accentInk hover:bg-accentDark",
    // Destructive — red only where data is actually lost
    danger: "bg-red-500 text-white hover:bg-red-600",
    outline: "border border-borderLight text-textMain hover:border-accent/50 hover:text-accentText",
    // Quiet neutral for secondary/inline controls
    ghost: "text-textMuted hover:text-textMain hover:bg-muted",
  };
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`${baseStyle} ${variants[variant] || variants.primary} ${className}`}
    >
      {children}
    </button>
  );
}
