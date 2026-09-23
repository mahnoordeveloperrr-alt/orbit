import React from 'react';

// Session/panel card — the reference DNA: DARK INTERIOR + COLORFUL EDGE.
// Flat surface fill, 1px border in the card's hue (subtle), 3px left bar,
// and a very subtle outer glow in the same hue via the .box-glow-* CSS
// utilities (single owner of the glow, spec §24: controlled, never neon).
// 14px radius, hover deepens the shadow slightly — color/shadow only.
export default function Card({ children, className = '', color = '' }) {
  const box = color ? `box-${color}` : '';
  const glow = color ? `box-glow-${color}` : '';
  return (
    <div
      className={`surface ${box} ${glow} rounded-[14px] border shadow-premium hover:shadow-premium-lg transition-shadow duration-150 ${className}`}
    >
      {children}
    </div>
  );
}
