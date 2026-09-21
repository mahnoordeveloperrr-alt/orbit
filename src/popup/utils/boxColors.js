// The five box colors — every card/panel carries one of these tints.
// Assign by index so lists cycle through the palette in order, and by
// name for fixed panels (Settings → purple, Organize → green, etc.).
export const BOX_COLORS = ['purple', 'orange', 'pink', 'blue', 'green'];

export const boxColorFor = (i) => BOX_COLORS[((i % BOX_COLORS.length) + BOX_COLORS.length) % BOX_COLORS.length];

// Button gradient per box color — the card's action button wears the
// card's own color (design-theme rule: same-color bar → same-color button).
// blue is the default/hero; it maps to the shared accent gradient classes.
export const BOX_GRADIENTS = {
  purple: 'bg-gradient-to-b from-violet-500 to-violet-700 hover:from-violet-400 hover:to-violet-600 shadow-violet-900/40',
  orange: 'bg-gradient-to-b from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 shadow-orange-900/40',
  pink: 'bg-gradient-to-b from-pink-500 to-pink-700 hover:from-pink-400 hover:to-pink-600 shadow-pink-900/40',
  blue: 'bg-gradient-to-b from-blue-500 to-blue-700 hover:from-blue-400 hover:to-blue-600 shadow-blue-900/40',
  green: 'bg-gradient-to-b from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 shadow-emerald-900/40',
};

// Fixed assignments for named panels (kept in one place so the app's
// color map is a single decision, not scattered classNames).
export const PANEL_BOX_COLORS = {
  welcome: 'purple',
  organize: 'green',
  trash: 'orange',
};
