import React from 'react';

// Glass card: translucent surface + backdrop blur over the blue-tinted page
// gradient, subtle border + shadow, 14px radius. Hover deepens the shadow
// slightly — a color/shadow change, never movement.
export default function Card({ children, className = '' }) {
  return (
    <div className={`glass rounded-[14px] border shadow-premium hover:shadow-premium-lg transition-shadow duration-150 ${className}`}>
      {children}
    </div>
  );
}
