import React from 'react';

// Glass card: translucent surface + backdrop blur over the neutral page
// gradient, subtle border + shadow, 14px radius. `color` picks one of the
// five box tints (purple/orange/pink/blue/green) — the shell itself stays
// monochrome; the color lives in the boxes. Hover deepens the shadow
// slightly — a color/shadow change, never movement.
export default function Card({ children, className = '', color = '' }) {
  const box = color ? `box-${color}` : '';
  return (
    <div className={`glass ${box} rounded-[14px] border shadow-premium hover:shadow-premium-lg transition-shadow duration-150 ${className}`}>
      {children}
    </div>
  );
}
