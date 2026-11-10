import React from 'react';

// Session/panel card — the reference DNA: DARK INTERIOR + COLORFUL EDGE.
// Flat surface fill, 1px border in the card's hue (subtle), 3px left bar,
// and a very subtle outer glow in the same hue via the .box-glow-* CSS
// utilities (single owner of the glow, spec §24: controlled, never neon).
// 14px radius, hover deepens the shadow slightly — color/shadow only.
// `style` is passed through so callers can stagger entrances (the `.rise`
// utility reads its delay from the --d custom property).
// NB: no hover-lift here on purpose — a transformed ancestor would break
// the session card's ⋯ menu (`position: fixed` coordinates, see SessionList).
export default function Card({ children, className = '', color = '', style }) {
  const box = color ? `box-${color}` : '';
  const glow = color ? `box-glow-${color}` : '';
  return (
    <div
      style={style}
      className={`surface ${box} ${glow} rounded-[14px] border shadow-premium hover:shadow-premium-lg transition-shadow duration-150 ${className}`}
    >
      {children}
    </div>
  );
}
