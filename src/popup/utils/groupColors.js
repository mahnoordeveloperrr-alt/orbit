// 🆕 Shared Chrome tab-group color → Tailwind dot class mapping
// Chrome's TabGroupColorEnum: grey, blue, red, yellow, green, pink, purple, cyan, orange
export const GROUP_DOT_COLORS = {
  grey: 'bg-gray-400',
  blue: 'bg-blue-500',
  red: 'bg-red-500',
  yellow: 'bg-yellow-400',
  green: 'bg-green-500',
  pink: 'bg-pink-500',
  purple: 'bg-purple-500',
  cyan: 'bg-cyan-500',
  orange: 'bg-orange-500'
};

export const dotClassFor = (color) => GROUP_DOT_COLORS[color] || 'bg-gray-400';
