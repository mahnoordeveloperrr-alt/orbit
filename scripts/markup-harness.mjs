// Generates scripts/markup-harness.html — a plain page that loads the REAL
// dist/markup-core.js + dist/markup-overlay.js with a tiny in-memory
// chrome.storage.local mock (nothing persists beyond this page; the harness
// exists to exercise the overlay UI in a real browser).
// Run: node scripts/markup-harness.mjs   → then open the HTML in a browser.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), 'utf8');
const dist = (p) => read(join('dist', p));

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Orbitabs Markup — live harness</title>
<style>
  body { font: 14px/1.6 Georgia, serif; margin: 0; }
  .article { max-width: 640px; margin: 24px auto; }
  h1 { font-size: 22px; }
  .para { color: #334; }
  .banner { background:#ede9fe; color:#4c1d95; padding:8px 14px; border-radius:8px; max-width:640px; margin:16px auto; font:600 13px system-ui; }
</style>
<style id="orbi-css-inject">${dist('markup-overlay.css')}</style>
<script>
  // chrome mock (in-memory) — the overlay uses storage.local get/set and
  // registers its open-command on runtime.onMessage.
  globalThis.__omListeners = [];
  globalThis.chrome = {
    storage: {
      local: {
        _db: {},
        async get(k) { return { [k]: this._db[k] }; },
        async set(obj) { Object.assign(this._db, obj); },
      },
    },
    runtime: {
      onMessage: {
        addListener(fn) { globalThis.__omListeners.push(fn); },
      },
    },
  };
</script>
<script>${dist('markup-core.js')}</script>
<script>${dist('markup-overlay.js')}</script>
<script>
  // Simulate the worker's ORBITABS_MARKUP_OPEN message (popup pen button).
  window.addEventListener('load', () => {
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      for (const fn of globalThis.__omListeners) {
        fn({ type: 'ORBITABS_MARKUP_OPEN', url: 'https://example.com/article' }, {}, () => {});
      }
      if (document.getElementById('orbitabs-markup-root') || tries > 20) clearInterval(t);
    }, 250);
  });
</script>
</head>
<body>
  <div class="banner">🧪 Orbitabs Markup live harness — overlay code is the REAL dist build. Try: fill palette + 🎨 picker, ink row (text color), click a mark → recolor, type a note → drag it, sticky cards (resize from the corner), eraser + undo, arrows (start dot + clamped head). Marks vanish on reload (in-memory mock).</div>
  <article class="article">
    <h1>Artificial intelligence is changing software development</h1>
    <p class="para">Lorem research body text. Highlight me! Highlight me! Highlight me! Highlight me! Highlight me! Highlight me! Highlight me!</p>
    <p class="para">A second paragraph with claims worth verifying. A second paragraph with claims worth verifying. A second paragraph with claims worth verifying. A second paragraph with claims worth verifying.</p>
  </article>
</body>
</html>`;

writeFileSync(join(root, 'scripts', 'markup-harness.html'), html);
console.log('wrote scripts/markup-harness.html (' + Math.round(html.length / 1024) + ' KB)');
