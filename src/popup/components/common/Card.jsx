import React from 'react';

// Flat, professional card: subtle border + shadow, 14px radius.
// Hover deepens the shadow slightly — a color/shadow change, never movement.
export default function Card({ children, className = '' }) {
  return (
    <div className={`bg-primary rounded-[14px] border border-borderLight/70 shadow-premium hover:shadow-premium-lg transition-shadow duration-150 ${className}`}>
      {children}
    </div>
  );
}
