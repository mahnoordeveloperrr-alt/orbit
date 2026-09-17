import { useState, useEffect } from 'react';

/* ---------------- theme (light / dark / system) ---------------- */

export const THEMES = ['light', 'dark', 'system'];

const systemPrefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

/** Resolve + apply: toggles the `dark` class the CSS tokens key off. */
export const applyTheme = (pref) => {
  const dark = pref === 'dark' || (pref === 'system' && systemPrefersDark());
  document.documentElement.classList.toggle('dark', dark);
};

export default function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'system');

  useEffect(() => { applyTheme(theme); }, [theme]);

  // 'system' follows the OS live
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const cycleTheme = () => {
    const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    localStorage.setItem('theme', next); // UI-only pref — worker needs nothing
    setTheme(next);
  };

  return { theme, cycleTheme };
}
