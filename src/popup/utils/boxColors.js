// Semantic color assignment for Orbitabs — the production spec's rule:
// color communicates STATE or CATEGORY, never random decoration.
//
//   purple / magenta → session identity (Research, selected, etc.)
//   blue             → secondary sessions
//   green            → PRIMARY actions (Save / Restore / toggles)
//   orange / yellow  → recovery / warnings (trash, crash banner)
//   red              → destructive / errors
//
// Sessions cycle a SHORT identity roster — magenta #FB00CD, deep blue
// #0019FB, amber #FB9200, and Google green (added for the light tint
// palette, user request: the #E6F4EA hue, worn one tint-step deeper at
// #CEEAD6 in light so it reads on the white card) — so every card, its chip
// and its Restore button all wear the SAME hue as the session. Green sits
// LAST in the cycle so existing cards keep their colours; in dark mode its
// token flips to the neon green like every other hue.

const BOX_COLORS = ['pink', 'blue', 'orange', 'green'];

export const boxColorFor = (i) => BOX_COLORS[((i % BOX_COLORS.length) + BOX_COLORS.length) % BOX_COLORS.length];
