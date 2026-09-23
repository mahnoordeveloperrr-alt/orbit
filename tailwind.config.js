/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // CSS variables (space-separated RGB) — themes swap via the `dark` class
        // on <html>; values live in src/index.css. /opacity utilities keep working.
        primary: "rgb(var(--c-primary) / <alpha-value>)",       // surface
        secondary: "rgb(var(--c-secondary) / <alpha-value>)",   // soft surface
        surface: "rgb(var(--c-surface) / <alpha-value>)",       // card fill
        accent: "rgb(var(--c-accent) / <alpha-value>)",         // brand (neon green)
        accentText: "rgb(var(--c-accent-text) / <alpha-value>)", // green as text
        accentInk: "rgb(var(--c-accent-ink) / <alpha-value>)",   // dark text on neon
        accentDark: "rgb(var(--c-accent-dark) / <alpha-value>)", // pressed neon
        textMain: "rgb(var(--c-text-main) / <alpha-value>)",
        textMuted: "rgb(var(--c-text-muted) / <alpha-value>)",
        borderLight: "rgb(var(--c-border) / <alpha-value>)",
        muted: "rgb(var(--c-muted) / <alpha-value>)",           // subtle fills
        onAccent: "rgb(var(--c-on-accent) / <alpha-value>)",    // text on neon fills
        boxOrange: "rgb(var(--box-orange) / <alpha-value>)",    // recovery/warning hue
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'premium': 'var(--shadow-premium)',
        'premium-lg': 'var(--shadow-premium-lg)',
      },
    },
  },
  plugins: [],
}