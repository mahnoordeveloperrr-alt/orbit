import { useState, useEffect } from 'react';

/* ---------------- theme (light / dark) ----------------
   SYSTEM MODE REMOVED (user request): the pref is now only 'light' or
   'dark'. A stored legacy 'system' (or unknown) value now uses the dark
   first-run default and is persisted for consistent future launches. */

export const THEMES = ['light', 'dark'];

/** Resolve + apply: toggles the `dark` class the CSS tokens key off. */
export const applyTheme = (pref) => {
  document.documentElement.classList.toggle('dark', pref === 'dark');
};

/** First-run read: valid pref wins; anything else starts in dark mode. */
const initialTheme = () => {
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') return stored;
  localStorage.setItem('theme', 'dark'); // persist the default for this user
  return 'dark';
};

export default function useTheme() {
  const [theme, setTheme] = useState(initialTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const cycleTheme = () => {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    localStorage.setItem('theme', next); // UI-only pref — worker needs nothing
    setTheme(next);
  };

  return { theme, cycleTheme };
}
