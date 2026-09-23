// Semantic color assignment for Orbitabs — the production spec's rule:
// color communicates STATE or CATEGORY, never random decoration.
//
//   purple / magenta → session identity (Research, selected, etc.)
//   blue             → secondary sessions
//   green            → PRIMARY actions (Save / Restore / toggles)
//   orange / yellow  → recovery / warnings (trash, crash banner)
//   red              → destructive / errors
//
// Sessions cycle a SHORT identity pair (magenta, purple, blue) so cards
// stay categorizable.

const BOX_COLORS = ['pink', 'purple', 'blue'];

export const boxColorFor = (i) => BOX_COLORS[((i % BOX_COLORS.length) + BOX_COLORS.length) % BOX_COLORS.length];
