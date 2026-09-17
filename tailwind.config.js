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
        accent: "rgb(var(--c-accent) / <alpha-value>)",         // brand
        accentLight: "rgb(var(--c-accent-light) / <alpha-value>)",
        textMain: "rgb(var(--c-text-main) / <alpha-value>)",
        textMuted: "rgb(var(--c-text-muted) / <alpha-value>)",
        borderLight: "rgb(var(--c-border) / <alpha-value>)",
        muted: "rgb(var(--c-muted) / <alpha-value>)",           // subtle fills
        onAccent: "rgb(var(--c-on-accent) / <alpha-value>)",    // text on accent fills
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