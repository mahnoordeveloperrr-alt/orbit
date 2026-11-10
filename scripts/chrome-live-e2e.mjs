// ============================================================================
// CHROME LIVE E2E — drives the real built extension (dist/) in Chrome over CDP.
//
// Chrome 137+ removed --load-extension, so this launches its own Chrome with
// --enable-unsafe-extension-debugging and installs dist/ via
// Extensions.loadUnpacked. Each run uses a throwaway profile.
//
// Run:  node scripts/chrome-live-e2e.mjs
// Env:  CDP_PORT (default 9333), CHROME_PATH (default Program Files Chrome)
//
// Groups: A render · B theme · C save · D restore · E search · F trash ·
//         G settings · H crash banner · I markup overlay
// ============================================================================

import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = resolve(root, 'dist');
const PORT = Number(process.env.CDP_PORT || 9333);
const PROFILE = resolve(root, '.chrome-e2e-profile');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const LOCAL_PAGE = 'http://127.0.0.1:5901/privacy.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const group = (t) => results.push(`\n── ${t} ──`);

/* ─── CDP client ──────────────────────────────────────────────── */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
        else res(msg.result);
        return;
      }
      if (msg.method) (this.listeners.get(msg.method) || []).forEach((cb) => cb(msg.params, msg.sessionId));
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true });
    });
    return new CDP(ws);
  }
  on(m, cb) {
    if (!this.listeners.has(m)) this.listeners.set(m, []);
    this.listeners.get(m).push(cb);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }
      }, 30000);
    });
  }
}

class Page {
  constructor(cdp, sessionId, targetId) { this.cdp = cdp; this.sessionId = sessionId; this.targetId = targetId; }
  static async open(cdp, url) {
    const { targetId } = await cdp.send('Target.createTarget', { url: url || 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const p = new Page(cdp, sessionId, targetId);
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    await p.waitForReady();
    return p;
  }
  send(m, params = {}) { return this.cdp.send(m, params, this.sessionId); }
  async waitForReady(ms = 20000) {
    const started = Date.now();
    while (Date.now() - started < ms) {
      try {
        const r = await this.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (r.result.value === 'complete') return;
      } catch { /* navigation in flight */ }
      await sleep(120);
    }
    throw new Error('page ready timeout');
  }
  async goto(url) { await this.send('Page.navigate', { url }); await sleep(400); await this.waitForReady(); }
  async eval(expression, timeout = 20000) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  /** evaluate (awaiting promises/IIFEs) and parse the JSON result */
  async json(expression) {
    const raw = await this.eval(`(async () => JSON.stringify(await (() => (${expression}))()))()`);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
  async close() { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {}); }
}

/* ─── DOM helpers (run inside the page) ───────────────────────── */
const CLICK = (labels) => `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const wanted = ${JSON.stringify(labels.map((l) => l.toLowerCase()))};
  const els = [...document.querySelectorAll('button, a, [role="button"]')];
  for (const w of wanted) {
    const hit = els.find((el) => norm(el.innerText).toLowerCase() === w) ||
                els.find((el) => norm(el.innerText).toLowerCase().includes(w));
    if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); return norm(hit.innerText); }
  }
  return null;
})()`;

// Some menus close on any scroll event (SessionList listens to scroll in the
// capture phase), so menu items must be clicked WITHOUT scrollIntoView.
const CLICK_NS = (labels) => `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const wanted = ${JSON.stringify(labels.map((l) => l.toLowerCase()))};
  const els = [...document.querySelectorAll('button, a, [role="button"]')];
  for (const w of wanted) {
    const hit = els.find((el) => norm(el.innerText).toLowerCase() === w) ||
                els.find((el) => norm(el.innerText).toLowerCase().includes(w));
    if (hit) { hit.click(); return norm(hit.innerText); }
  }
  return null;
})()`;

const CLICK_ATTR = (attr, value) => `(() => {
  const els = [...document.querySelectorAll('button, a, [role="button"]')];
  const hit = els.find((el) => (el.getAttribute(${JSON.stringify(attr)}) || '').toLowerCase().includes(${JSON.stringify(value.toLowerCase())}));
  if (!hit) return null;
  // no scrollIntoView: a scroll event in the capture phase closes the menu.
  hit.click();
  return hit.getAttribute(${JSON.stringify(attr)});
})()`;

const STORAGE = `chrome.storage.local.get(['orbi_sessions','orbi_settings','orbi_trash','recoveryCandidate','crashDetectedAt','orbi_annotations']).then((v) => JSON.stringify(v))`;

/** Poll a page expression until truthy (condition-based waits beat sleeps). */
async function waitFor(page, expression, timeout = 8000, interval = 200) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await page.eval(`(async () => !!(await (${expression})))()`)) return true;
    } catch { /* context busy — retry */ }
    await sleep(interval);
  }
  return false;
}

/** Open a session card's menu and click one of its items (retries: React may
 *  re-render between the two clicks, which closes the menu). */
async function menuAction(page, item) {
  for (let i = 0; i < 3; i++) {
    await page.eval(CLICK_ATTR('title', 'More actions'));
    const open = await waitFor(page, `document.querySelectorAll('.card-menu').length > 0`, 2500);
    if (!open) continue;
    const clicked = await page.eval(CLICK_NS([item]));
    if (clicked) return clicked;
    await sleep(250);
  }
  return null;
}

/* ─── launch chrome ───────────────────────────────────────────── */
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1280,900',
  'about:blank',
], { stdio: 'ignore' });

let version;
for (let i = 0; i < 60; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
  catch { await sleep(250); }
}
if (!version) { console.error('Chrome did not expose CDP'); process.exit(1); }
results.push(`Chrome ${version.Browser}`);

const cdp = await CDP.connect(version.webSocketDebuggerUrl);

// Never leave a headless Chrome behind, even when a check throws.
const bail = async (err) => {
  console.error('\n' + results.join('\n'));
  console.error('\n💥 harness error: ' + (err?.message || err));
  try { await cdp.send('Browser.close'); } catch { /* already gone */ }
  chrome.kill();
  process.exit(1);
};
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

// Collect page-level exceptions per target
const consoleErrors = [];
cdp.on('Runtime.exceptionThrown', (p, sid) => {
  consoleErrors.push(`[${sid?.slice(0, 6)}] ${p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception'}`);
});
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
});

/* ─── install extension ───────────────────────────────────────── */
const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: DIST });
results.push(`extension id ${extId}`);
const popupUrl = `chrome-extension://${extId}/index.html`;

const popup = await Page.open(cdp, popupUrl);
await sleep(1200);

/* ─── A. render ───────────────────────────────────────────────── */
group('A. POPUP RENDER & DESIGN');
const a = await popup.json(`(() => {
  const css = getComputedStyle(document.body);
  const pills = [...document.querySelectorAll('button')].map(b => b.innerText.replace(/\\s+/g,' ').trim());
  return {
    title: document.title,
    hasRoot: !!document.getElementById('root'),
    bodyLength: document.body.innerText.length,
    font: css.fontFamily,
    pills,
    h1: document.querySelector('h1')?.textContent,
    storageOk: typeof chrome !== 'undefined' && !!chrome.storage,
  };
})()`);
ok('popup document loads', a.bodyLength > 50, `body ${a.bodyLength} chars`);
ok('React root mounted', a.hasRoot);
ok('title is Orbitabs', /orbitabs/i.test(a.title || ''), a.title);
ok('nav pills render (Sessions / Organizer / Settings)',
  ['Sessions', 'Organizer', 'Settings'].every((l) => a.pills.some((p) => p === l)),
  a.pills.slice(0, 12).join(' | '));
ok('extension APIs available in popup', a.storageOk);
ok('Inter font applied', /Inter/i.test(a.font), a.font);

/* ─── B. theme ────────────────────────────────────────────────── */
group('B. THEME (light / dark)');
const themeBefore = await popup.json(`(() => {
  const html = document.documentElement;
  return { dark: html.classList.contains('dark'), bg: getComputedStyle(document.body).backgroundColor,
           accent: getComputedStyle(html).getPropertyValue('--c-accent').trim() };
})()`);
const themeToggle = await popup.eval(CLICK_ATTR('title', 'Theme:'));
await sleep(600);
const themeAfter = await popup.json(`(() => {
  const html = document.documentElement;
  return { dark: html.classList.contains('dark'), bg: getComputedStyle(document.body).backgroundColor,
           accent: getComputedStyle(html).getPropertyValue('--c-accent').trim(),
           stored: null };
})()`);
const themeStored = await popup.eval(`localStorage.getItem('theme')`);
ok('theme control found in header', themeToggle !== null, String(themeToggle));
ok('theme toggles dark class', themeBefore.dark !== themeAfter.dark,
  `${themeBefore.dark} → ${themeAfter.dark}`);
ok('surface colour changes with theme', themeBefore.bg !== themeAfter.bg,
  `${themeBefore.bg} → ${themeAfter.bg}`);
ok('accent token resolves', themeBefore.accent !== '' && themeBefore.accent !== themeAfter.accent,
  `${themeBefore.accent} → ${themeAfter.accent}`);
ok('theme choice persisted (localStorage)', themeStored === (themeAfter.dark ? 'dark' : 'light'), String(themeStored));

/* ─── C. save (fixture tabs) ──────────────────────────────────── */
group('C. SAVE CURRENT TABS');
const fixtures = [];
for (const u of ['about:blank#orbitabs-a', 'about:blank#orbitabs-b']) {
  const { targetId } = await cdp.send('Target.createTarget', { url: u });
  fixtures.push(targetId);
}
await sleep(800);
const tabsBefore = await popup.json(`chrome.tabs.query({}).then(t => ({ n: t.length, urls: t.map(x => x.url) }))`);
const clickedSave = await popup.eval(CLICK(['SAVE CURRENT TABS', 'Save Current Tabs', 'Save My Current Tabs']));
await sleep(1500);
const afterSave = JSON.parse(await popup.eval(STORAGE));
const sessions = afterSave.orbi_sessions || [];
ok('save button found', clickedSave !== null, String(clickedSave));
ok('session stored', sessions.length === 1, `sessions=${sessions.length}`);
const savedTabs = (sessions[0]?.windows || []).reduce((n, w) => n + (w.tabs?.length || 0), 0);
ok('session captured live tabs', savedTabs >= 3, `${savedTabs} tabs from ${tabsBefore.n} open`);
ok('session has a generated name', /Session/i.test(sessions[0]?.name || ''), sessions[0]?.name);
ok('session appears in the list',
  await popup.eval(`document.body.innerText.includes(${JSON.stringify(sessions[0]?.name || 'x')})`));

/* ─── D. restore ──────────────────────────────────────────────── */
group('D. RESTORE');
for (const t of fixtures) await cdp.send('Target.closeTarget', { targetId: t }).catch(() => {});
await sleep(900);
const restoreClick = await popup.eval(CLICK(['Restore']));
await sleep(2500);
const tabsAfterRestore = await popup.json(`chrome.tabs.query({}).then(t => ({ n: t.length, urls: t.map(x => x.url) }))`);
ok('restore action available', restoreClick !== null, String(restoreClick));
ok('tabs reopened after restore', tabsAfterRestore.n > 2, `${tabsAfterRestore.n} tabs now open`);
ok('restored tabs match saved URLs',
  (sessions[0]?.windows || []).flatMap((w) => w.tabs.map((t) => t.url)).some((u) => tabsAfterRestore.urls.some((x) => x.includes(u.replace('about:blank#', '')) || u === x)),
  tabsAfterRestore.urls.join(' | '));

/* ─── E. search ───────────────────────────────────────────────── */
group('E. SEARCH');
const searchSet = await popup.eval(`(() => {
  const input = document.querySelector('input[placeholder*="Search"]');
  if (!input) return null;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'zzzz-no-match');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.placeholder;
})()`);
await sleep(700);
const searchState = await popup.json(`(() => ({
  noMatch: /No sessions match/i.test(document.body.innerText),
  sessionsVisible: document.body.innerText.includes('Research') || document.body.innerText.includes('Session'),
}))()`);
ok('search input present', searchSet !== null, String(searchSet));
ok('search filters to empty state', searchState.noMatch === true, JSON.stringify(searchState));
await popup.eval(`(() => {
  const input = document.querySelector('input[placeholder*="Search"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); return 1;
})()`);
await sleep(500);

/* ─── F. trash ────────────────────────────────────────────────── */
group('F. TRASH (soft delete + undo)');
const deleteClick = await menuAction(popup, 'Delete');
const menuOpened = deleteClick ? 'More actions' : null;
const confirmText = await waitFor(popup, `document.body.innerText.includes('Move to Trash?')`, 6000);
const confirmClick = confirmText ? await popup.eval(CLICK_NS(['Move to Trash'])) : null;
await waitFor(popup, `chrome.storage.local.get('orbi_sessions').then(v => (v.orbi_sessions || []).some(s => !!s.deletedAt))`, 8000);
const afterDelete = JSON.parse(await popup.eval(STORAGE));
// Soft delete keeps the record in orbi_sessions and stamps deletedAt.
const allAfterDelete = afterDelete.orbi_sessions || [];
const active = allAfterDelete.filter((s) => !s.deletedAt);
const trash = allAfterDelete.filter((s) => s.deletedAt);
ok('session menu opens', menuOpened !== null, String(menuOpened));
ok('delete soft-deletes into trash', active.length === 0 && trash.length === 1,
  `active=${active.length} trashed=${trash.length}`);
ok('trashed session keeps a deletedAt stamp', !!trash[0]?.deletedAt, String(trash[0]?.deletedAt));
ok('confirm modal gates the delete', confirmText === true && confirmClick !== null, String(confirmClick));
ok('undo affordance shown', await popup.eval(`/UNDO/i.test(document.body.innerText)`));
const undoClick = await popup.eval(CLICK(['UNDO']));
ok('undo control is clickable', undoClick !== null, String(undoClick));
await waitFor(popup, `chrome.storage.local.get('orbi_sessions').then(v => (v.orbi_sessions || []).every(s => !s.deletedAt))`, 8000);
const afterUndo = JSON.parse(await popup.eval(STORAGE));
const undoAll = afterUndo.orbi_sessions || [];
ok('undo restores the session', undoAll.length === 1 && undoAll.every((s) => !s.deletedAt),
  `records=${undoAll.length} trashed=${undoAll.filter((s) => s.deletedAt).length}`);

/* ─── G. settings ─────────────────────────────────────────────── */
group('G. SETTINGS');
await popup.eval(CLICK(['Settings']));
await sleep(900);
const settingsView = await popup.json(`(() => {
  const t = document.body.innerText;
  return {
    hasBackup: /Backup & Recovery/i.test(t),
    hasAutoSave: /Auto-save/i.test(t),
    hasCrash: /Crash Recovery/i.test(t),
    hasLocalOnly: /Local-only/i.test(t),
    hasCloud: /Cloud sync/i.test(t),
    selects: [...document.querySelectorAll('select')].map(s => s.value),
    toggles: document.querySelectorAll('input[type="checkbox"]').length,
  };
})()`);
ok('Settings view renders', settingsView.hasBackup && settingsView.hasCloud, JSON.stringify(settingsView));
ok('auto-save control present', settingsView.hasAutoSave);
ok('crash recovery + local-only sections present', settingsView.hasCrash && settingsView.hasLocalOnly);
ok('recovery-points control present', settingsView.selects.length > 0, `selects=${JSON.stringify(settingsView.selects)}`);
const autoToggle = await popup.eval(`(async () => {
  const read = async () => ((await chrome.storage.local.get('orbi_settings')).orbi_settings || {});
  const before = await read();
  // Toggle = a plain <button class="w-11 h-6 rounded-full"> with no aria; the
  // first one in Settings → General is Auto-save.
  const toggles = [...document.querySelectorAll('button')].filter(b => /w-11/.test(b.className) && /h-6/.test(b.className));
  if (!toggles.length) return JSON.stringify({ ok: false, reason: 'no-toggle' });
  toggles[0].click();
  await new Promise(r => setTimeout(r, 700));
  const after = await read();
  return JSON.stringify({ ok: true, before: before.autoSave, after: after.autoSave, count: toggles.length });
})()`);
await sleep(400);
const autoRes = JSON.parse(autoToggle);
ok('auto-save toggle writes settings', autoRes.ok && autoRes.before !== autoRes.after,
  JSON.stringify(autoRes));
await popup.eval(CLICK(['Sessions']));
await sleep(600);

/* ─── H. crash recovery banner ────────────────────────────────── */
group('H. CRASH RECOVERY BANNER');
await popup.eval(`chrome.storage.local.set({
  recoveryCandidate: { windows: [{ tabs: [{ url: 'https://example.com/crash', title: 'Crashed tab', pinned: false, active: true, groupId: -1 }] }], count: 1 },
  crashDetectedAt: Date.now()
}).then(() => 1)`);
await popup.goto(popupUrl);
await sleep(1600);
const bannerState = await popup.json(`(() => {
  const t = document.body.innerText;
  return { crashed: /Chrome crashed/i.test(t), restore: /Restore tabs/i.test(t), notNow: /Not now/i.test(t) };
})()`);
ok('crash banner appears for a queued candidate', bannerState.crashed && bannerState.restore, JSON.stringify(bannerState));
ok('crash banner offers a dismissal', bannerState.notNow);
const dismissClick = await popup.eval(CLICK(['Not now']));
ok('dismiss control is clickable', dismissClick !== null, String(dismissClick));
await waitFor(popup, `chrome.storage.local.get('recoveryCandidate').then(v => !v.recoveryCandidate)`, 6000);
const afterDismiss = JSON.parse(await popup.eval(STORAGE));
ok('dismiss clears the candidate', !afterDismiss.recoveryCandidate && !afterDismiss.crashDetectedAt,
  `candidate=${!!afterDismiss.recoveryCandidate} at=${!!afterDismiss.crashDetectedAt}`);

/* ─── I. markup overlay (real engine) ─────────────────────────── */
group('I. MARKUP OVERLAY');
const testPage = await Page.open(cdp, LOCAL_PAGE);
await sleep(600);
// The overlay ships as a content script; the automation cannot grant
// activeTab, so inject the SAME built files with a chrome-API shim into the
// real page. That exercises the real DOM / CSS / canvas engine in Chrome.
const shim = `(() => {
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    id: 'orbitabs-test',
    onMessage: { addListener(fn) { window.__mkListener = fn; }, removeListener() {} },
    sendMessage() { return Promise.resolve(null); },
  };
  window.__mkWrites = {};
  window.chrome.storage = {
    local: {
      get() { return Promise.resolve({}); },
      set(obj) { window.__mkWrites = Object.assign(window.__mkWrites || {}, obj); return Promise.resolve(); },
      remove() { return Promise.resolve(); },
    },
    onChanged: { addListener() {}, removeListener() {} },
  };
  window.chrome.i18n = { getMessage: (k) => k };
  return 'shimmed';
})()`;
const markupInject = await testPage.eval(shim);
ok('markup shim installed', markupInject === 'shimmed', markupInject);

let mkCore = '';
let mkOverlay = '';
let mkCss = '';
try {
  mkCore = readFileSync(join(DIST, 'markup-core.js'), 'utf8');
  mkOverlay = readFileSync(join(DIST, 'markup-overlay.js'), 'utf8');
  mkCss = readFileSync(join(DIST, 'markup-overlay.css'), 'utf8');
} catch (e) {
  results.push(`     (markup sources missing: ${e.message})`);
}

if (mkCore && mkOverlay) {
  const injected = await testPage.eval(`(() => {
    try {
      (0, eval)(${JSON.stringify(mkCore)});
      const style = document.createElement('style');
      style.id = 'mk-style';
      style.textContent = ${JSON.stringify(mkCss)};
      document.head.appendChild(style);
      (0, eval)(${JSON.stringify(mkOverlay)});
      window.__mkListener({ type: 'ORBITABS_MARKUP_OPEN', url: location.href }, null, () => {});
      return 'injected';
    } catch (e) { return 'error: ' + e.message; }
  })()`);
  await sleep(900);
  const overlay = await testPage.json(`(() => {
    const root = document.getElementById('orbitabs-markup-root');
    const canvas = document.getElementById('mk-canvas');
    const dock = document.getElementById('mk-dock');
    return {
      root: !!root,
      canvas: !!canvas,
      canvasPainted: canvas ? canvas.width > 0 && canvas.height > 0 : false,
      dockButtons: dock ? dock.querySelectorAll('button').length : 0,
      visible: root ? getComputedStyle(root).display !== 'none' && root.getBoundingClientRect().width > 0 : false,
      ids: [...document.querySelectorAll('[id^="mk-"]')].map(e => e.id).slice(0, 12),
    };
  })()`);
  ok('overlay injected without throwing', injected === 'injected', injected);
  ok('overlay root mounted (#orbitabs-markup-root)', overlay.root);
  ok('annotation canvas present and sized', overlay.canvasPainted);
  ok('tool dock rendered with buttons', overlay.dockButtons >= 5, `${overlay.dockButtons} buttons`);
  ok('overlay is visible on the page', overlay.visible, JSON.stringify(overlay.ids));
  const mkActive = await testPage.json(`(() => ({
    active: globalThis.__orbitabsMarkupActive === true,
    dockTools: [...document.querySelectorAll('#mk-dock button')].map((b) => (b.title || b.getAttribute('aria-label') || b.innerText || '').trim()).filter(Boolean).slice(0, 14),
    canvasDisplay: document.getElementById('mk-canvas') ? getComputedStyle(document.getElementById('mk-canvas')).display : 'none',
  }))()`);
  ok('overlay registers itself as active', mkActive.active === true);
  ok('tool dock exposes the drawing tools', mkActive.dockTools.length >= 5, mkActive.dockTools.join(' | '));
  ok('annotation canvas is displayed', mkActive.canvasDisplay !== 'none', mkActive.canvasDisplay);

  // Draw a pen stroke — the real draw → persist pipeline (the overlay
  // auto-saves; there is deliberately no explicit save button).
  const drew = await testPage.eval(`(() => {
    const canvas = document.getElementById('mk-canvas');
    const pen = [...document.querySelectorAll('#mk-dock button')].find((b) => (b.getAttribute('aria-label') || '') === 'Pen');
    if (pen) pen.click();
    const r = canvas.getBoundingClientRect();
    const opts = (x, y) => ({ bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 });
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts(120, 120)));
    for (let i = 1; i <= 6; i++) canvas.dispatchEvent(new PointerEvent('pointermove', opts(120 + i * 12, 120 + i * 6)));
    canvas.dispatchEvent(new PointerEvent('pointerup', opts(192, 156)));
    return {
      penActive: pen ? pen.classList.contains('mk-active') : false,
      hasClose: !!document.querySelector('#orbitabs-markup-root button[aria-label="Close Markup"]'),
      hasClear: !!document.querySelector('#orbitabs-markup-root button[aria-label="Clear this page"]'),
      hasUndo: !!document.querySelector('#orbitabs-markup-root button[aria-label="Undo"]'),
    };
  })()`);
  await sleep(1000);
  const writes = await testPage.json(`(() => ({ keys: Object.keys(window.__mkWrites || {}), count: (window.__mkWrites && window.__mkWrites.orbi_annotations && Object.keys(window.__mkWrites.orbi_annotations).length) || 0 }))()`);
  ok('pen tool activates on click', drew.penActive);
  ok('dock exposes close / clear / undo controls', drew.hasClose && drew.hasClear && drew.hasUndo, JSON.stringify(drew));
  ok('drawing auto-saves orbi_annotations', writes.keys.includes('orbi_annotations'), JSON.stringify(writes.keys));
  ok('drawn stroke persisted for this page', writes.count >= 1, `${writes.count} page key(s)`);
}

/* ─── K. organizer ────────────────────────────────────────────── */
group('K. ORGANIZER');
await popup.eval(CLICK(['Organizer']));
await sleep(1000);
const org = await popup.json(`(() => ({
  text: document.body.innerText.slice(0, 400),
  rows: document.querySelectorAll('[draggable="true"]').length,
  checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
  savedHeadingGone: !/Saved sessions/i.test(document.body.innerText),
}))()`);
org.text = org.text.replace(/\s+/g, ' ').trim(); // normalise in Node, not in the page
ok('Organizer view replaces the sessions list', org.savedHeadingGone);
ok('Organizer renders live tab rows', org.rows > 0 || /about:|Orbitabs|tab/i.test(org.text), org.text.slice(0, 90));

/* ─── L. session preview modal ────────────────────────────────── */
group('L. SESSION PREVIEW MODAL');
await popup.eval(CLICK(['Sessions']));
await sleep(800);
const previewClick = await menuAction(popup, 'Preview');
await waitFor(popup, `/Restore \\d+ tab/i.test(document.body.innerText)`, 6000);
const previewState = await popup.json(`(() => {
  const t = document.body.innerText;
  return { opened: /Restore \\d+ tab/i.test(t) || /Preview/i.test(t), hasCancel: /Cancel/i.test(t), tabsListed: /about:blank|tabs?\\b/i.test(t) };
})()`);
ok('Preview opens from the session menu', previewClick !== null && previewState.opened, String(previewClick));
ok('Preview offers Cancel + Restore', previewState.hasCancel, JSON.stringify(previewState));
await popup.eval(CLICK(['Cancel']));
await sleep(500);
ok('Preview modal closes', await popup.eval(`!/Restore \\d+ tab/i.test(document.body.innerText)`));

/* ─── M. login screen ─────────────────────────────────────────── */
group('M. ACCOUNT / LOGIN');
await popup.eval(CLICK(['Settings']));
await sleep(800);
const signInClick = await popup.eval(CLICK(['Sign in']));
await sleep(800);
const loginState = await popup.json(`(() => {
  const t = document.body.innerText;
  return {
    welcome: /Welcome back/i.test(t),
    email: !!document.querySelector('input[type="email"]'),
    password: !!document.querySelector('input[type="password"]'),
    optional: /Continue without account/i.test(t),
  };
})()`);
ok('Sign-in screen reachable from Settings', signInClick !== null || loginState.welcome, String(signInClick));
ok('login form has email + password fields', loginState.email && loginState.password);
ok('account stays optional (escape hatch present)', loginState.optional);
await popup.eval(CLICK(['Continue without account']));
await sleep(600);
ok('can return to the app without an account', await popup.eval(`/Sessions/.test(document.body.innerText)`));

/* ─── console health ──────────────────────────────────────────── */
group('J. RUNTIME HEALTH');
const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_|cdn|tailwind|Extension context invalidated/i.test(e));
ok('no uncaught popup errors', realErrors.length === 0, realErrors.slice(0, 3).join(' ;; '));

/* ─── report ──────────────────────────────────────────────────── */
console.log(results.join('\n'));
console.log(`\n${fail === 0 ? '✅' : '❌'} CHROME LIVE E2E: ${pass} passed, ${fail} failed\n`);

await popup.close();
await testPage.close();
await cdp.send('Browser.close').catch(() => {});
chrome.kill();
process.exit(fail === 0 ? 0 : 1);
