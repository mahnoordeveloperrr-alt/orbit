// Error boundary contract — a crash in any component can never blank the popup:
//   1. ROOT     — main.jsx wraps <App /> in <ErrorBoundary emergency label="popup">
//   2. CRASH    — a throwing child → emergency screen (not a white popup)
//   3. ISOLATE  — nested (non-emergency) boundaries fail silently; siblings survive
//   4. RECOVERY — the emergency screen still offers crash recovery, guarded by its
//                 own boundary, and the banner's Restore/Dismiss actually work
//   5. RESET    — "Try again" re-renders the real tree once the cause is gone
//
// Run: node scripts/error-boundary.test.mjs   (same harness as the other smokes)

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

/* ---------------- jsdom globals (same harness as the other smokes) ---------------- */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true, // requestAnimationFrame for gsap
});
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'MouseEvent', 'getComputedStyle']) {
  Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* ---------------- vite SSR loader ---------------- */
const vite = await import('vite');
const server = await vite.createServer({
  root, configFile: false, plugins: [],
  optimizeDeps: { disabled: true },
  server: { middlewareMode: true },
  appType: 'custom', logLevel: 'error',
});

/* ---------------- chrome.* mock (recovery candidate available, like dashboard-smoke) ---------------- */
const calls = [];
const rec = (kind) => async (...a) => { calls.push([kind, JSON.parse(JSON.stringify(a))]); return { ok: true }; };
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => {
          if (k === 'recoveryCandidate') out[k] = { windows: [{ tabs: [{}, {}, {}] }], savedAt: Date.now() - 20000 };
          if (k === 'crashDetectedAt') out[k] = Date.now() - 15000;
        });
        return out;
      },
      set: rec('storage.local.set'), remove: rec('storage.local.remove'),
    },
  },
  runtime: {
    sendMessage: rec('runtime.sendMessage'),
    onMessage: { addListener() {} },
    lastError: null,
  },
};

/* ---------------- load + helpers ---------------- */
const { default: ErrorBoundary } = await server.ssrLoadModule('/src/popup/components/common/ErrorBoundary.jsx');
const React = require('react');

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const act = (fn) => require('react-dom/test-utils').act(fn);
const fire = (el, type, opts = {}) => el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, view: dom.window, ...opts }));
const byText = (selector, text, rootNode = document) =>
  [...rootNode.querySelectorAll(selector)].filter(el => el.textContent.trim().includes(text));
const deepest = (els) => els.sort((a, b) => a.textContent.length - b.textContent.length)[0];

// Render a fresh tree in a fresh container; returns { unmount }
const mount = async (element) => {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const el = require('react-dom/client').createRoot(container);
  await act(async () => { el.render(element); });
  await tick(150);
  return { container, unmount: async () => { await act(async () => { el.unmount(); }); container.remove(); } };
};

console.log('\n── 1. ROOT: boundary wraps the app at the entry point ──');
const mainJs = readFileSync(root + '/src/popup/main.jsx', 'utf8');
ok('main.jsx mounts <ErrorBoundary emergency> around <App />',
  mainJs.includes('<ErrorBoundary emergency label="popup">') && mainJs.includes('<App />'));
ok('boundary is the ONLY root-level wrapper (emergency screen owns recovery)',
  mainJs.indexOf('ErrorBoundary') < mainJs.indexOf('<App />'));

console.log('\n── 2. CRASH: throwing child → emergency screen, not a blank popup ──');
// A component that throws only while `armed` — lets test 5 verify the RESET path.
const bomb = { armed: true };
const Bomb = () => { if (bomb.armed) throw new Error('💥 render bomb'); return React.createElement('p', null, 'all good'); };

let t = await mount(React.createElement(ErrorBoundary, { emergency: true, label: 'test' }, React.createElement(Bomb)));
ok('emergency screen renders (title + reassurance)', document.body.textContent.includes('Orbitabs hit a snag') && document.body.textContent.includes('Your saved sessions are safe'));
ok('Try again offered', byText('button', 'Try again').length > 0);
ok('no crashed-child content leaked through', document.body.textContent.includes('all good') === false);
await t.unmount();

console.log('\n── 3. ISOLATE: nested boundaries fail silently, siblings survive ──');
t = await mount(React.createElement('div', null,
  React.createElement(ErrorBoundary, null, React.createElement(Bomb)),
  React.createElement('p', { 'data-sib': true }, 'survivor'),
));
ok('broken widget removed silently (no emergency chrome)', document.body.textContent.includes('Orbitabs hit a snag') === false);
ok('sibling outside the boundary still renders', document.body.textContent.includes('survivor'));
await t.unmount();

console.log('\n── 4. RECOVERY: the emergency screen still offers crash recovery ──');
const src = readFileSync(root + '/src/popup/components/common/ErrorBoundary.jsx', 'utf8');
ok('banner mounted under its own nested boundary in the fallback', /<ErrorBoundary>\s*<RecoveryBanner \/>/.test(src));

// Fresh mount for Restore — restoring animates the banner out, so each path
// needs its own banner instance.
t = await mount(React.createElement(ErrorBoundary, { emergency: true, label: 'test' }, React.createElement(Bomb)));
ok('recovery banner visible inside the emergency screen', document.body.textContent.includes('Chrome crashed'));
calls.length = 0;
await act(async () => { fire(deepest(byText('button', 'Restore')), 'click'); });
await tick(450); // 0.2s exit animation
ok('Restore inside emergency screen → RESTORE_RECOVERY sent', calls.some(([k, a]) => k === 'runtime.sendMessage' && a[0]?.type === 'RESTORE_RECOVERY'));
await t.unmount();

// Fresh mount for Dismiss
t = await mount(React.createElement(ErrorBoundary, { emergency: true, label: 'test' }, React.createElement(Bomb)));
await act(async () => { fire(deepest(byText('button', 'Not now')), 'click'); });
await tick(450);
ok('Dismiss inside emergency screen → DISMISS_RECOVERY sent', calls.some(([k, a]) => k === 'runtime.sendMessage' && a[0]?.type === 'DISMISS_RECOVERY'));
ok('screen still usable after banner interactions (Try again intact)', byText('button', 'Try again').length > 0);
await t.unmount();

console.log('\n── 5. RESET: Try again re-renders the real tree once the cause is gone ──');
t = await mount(React.createElement(ErrorBoundary, { emergency: true, label: 'test' }, React.createElement(Bomb)));
ok('crashed → emergency screen shown first', document.body.textContent.includes('Orbitabs hit a snag'));
bomb.armed = false; // "fix" the cause, as the next launch would
const retry = deepest(byText('button', 'Try again'));
await act(async () => { fire(retry, 'click'); });
await tick(120);
ok('Try again → real tree renders again', document.body.textContent.includes('all good'));
ok('emergency screen gone after reset', document.body.textContent.includes('Orbitabs hit a snag') === false);
await t.unmount();

await server.close();
console.log(`\n✅ ERROR BOUNDARY SMOKE: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
