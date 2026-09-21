import React from 'react';

/**
 * Orbitabs brand mark — mirrors scripts/gen-icons.mjs in SVG:
 * rounded blue square, white orbit ring, preserved core, three satellite
 * dots (the "organized tabs"). One component, three sizes; `mono` renders
 * the ring variant on any background (used in the emergency screen).
 */
export default function Logo({ size = 20, mono = false }) {
  const s = size;
  const box = { width: s, height: s, flexShrink: 0 };
  if (mono) {
    return (
      <svg viewBox="0 0 32 32" style={box} aria-hidden="true">
        <circle cx="16" cy="16" r="9.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="16" cy="16" r="4" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32" style={box} aria-hidden="true">
      <defs>
        <linearGradient id="orbi-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#a855f7" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="32" height="32" rx="7.5" fill="url(#orbi-g)" />
      {/* orbit ring */}
      <circle cx="16" cy="16" r="9.6" fill="none" stroke="#fff" strokeOpacity="0.95" strokeWidth="2.2" />
      {/* preserved core */}
      <circle cx="16" cy="16" r="4.1" fill="#fff" />
      {/* three satellite dots — organized tabs (visible at this size) */}
      <circle cx="22.8" cy="9.2" r="2" fill="#fff" />
      <circle cx="6.4" cy="16" r="2" fill="#fff" />
      <circle cx="22.8" cy="22.8" r="2" fill="#fff" />
    </svg>
  );
}
