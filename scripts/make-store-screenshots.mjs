// ============================================================================
// STORE SCREENSHOTS — renders five 1280x800 listing images from the REAL
// built extension (dist/) running in Chrome, composed with the brand template.
//
// Run:  node scripts/make-store-screenshots.mjs
// Out:  store-assets/01-dashboard-1280x800.png … 05-markup-1280x800.png
//
// Chrome 137+ removed --load-extension → CDP Extensions.loadUnpacked.
// Composition uses sharp (from cloud-api/node_modules) rendering one SVG per
// shot: brand background + caption + the captured popup frame.
// ============================================================================

import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('../cloud-api/node_modules/sharp');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = resolve(root, 'dist');
const OUT = resolve(root, 'store-assets');
const PROFILE = resolve(root, '.chrome-e2e-profile');
const PORT = Number(process.env.CDP_PORT || 9335);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── CDP ─────────────────────────────────────────────────────── */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve: res, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else res(m.result);
      }
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
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout: ' + method)); } }, 30000);
    });
  }
}

class Page {
  constructor(cdp, sid, tid) { this.cdp = cdp; this.sid = sid; this.tid = tid; }
  static async open(cdp, url) {
    const { targetId } = await cdp.send('Target.createTarget', { url: url || 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const p = new Page(cdp, sessionId, targetId);
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    return p;
  }
  send(m, params = {}) { return this.cdp.send(m, params, this.sid); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async shot() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    return Buffer.from(data, 'base64');
  }
  async close() { await this.cdp.send('Target.closeTarget', { targetId: this.tid }).catch(() => {}); }
}

const CLICK = (labels) => `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const wanted = ${JSON.stringify(labels.map((l) => l.toLowerCase()))};
  const els = [...document.querySelectorAll('button, a, [role="button"]')];
  for (const w of wanted) {
    const hit = els.find((el) => norm(el.innerText) === w) || els.find((el) => norm(el.innerText).includes(w));
    if (hit) { hit.click(); return norm(hit.innerText); }
  }
  return null;
})()`;

/* ─── launch + install ────────────────────────────────────────── */
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--force-device-scale-factor=1', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

let version;
for (let i = 0; i < 80; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
  catch { await sleep(250); }
}
if (!version) { console.error('Chrome did not start'); process.exit(1); }

const cdp = await CDP.connect(version.webSocketDebuggerUrl);
const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: DIST });
const popupUrl = `chrome-extension://${extId}/index.html`;
console.log('extension', extId);

/* ─── realistic demo data ─────────────────────────────────────── */
const now = Date.now();
const session = {
  _id: 'demo-research-sprint',
  name: 'Research sprint',
  createdAt: new Date(now - 2 * 864e5).toISOString(),
  updatedAt: new Date(now - 2 * 864e5).toISOString(),
  windows: [{
    id: 'w1',
    tabs: [
      { id: 't1', url: 'https://developer.chrome.com/docs/extensions', title: 'Extensions docs', pinned: true, active: true, groupId: 'g1' },
      { id: 't2', url: 'https://news.ycombinator.com', title: 'Hacker News', pinned: false, active: false, groupId: 'g1' },
      { id: 't3', url: 'https://github.com/orbitabs', title: 'orbitabs — GitHub', pinned: false, active: false, groupId: 'g2' },
      { id: 't4', url: 'https://figma.com/file/landing', title: 'Landing page — Figma', pinned: false, active: false, groupId: -1 },
    ],
    groups: [
      { id: 'g1', title: 'Research', color: 'blue', collapsed: false },
      { id: 'g2', title: 'Build', color: 'purple', collapsed: false },
    ],
  }],
};
const crashCandidate = {
  savedAt: now - 4 * 60 * 1000,
  windows: [{
    id: 'cw1',
    tabs: [
      { id: 'c1', url: 'https://example.com/a', title: 'Crash tab A', pinned: false, active: true, groupId: -1 },
      { id: 'c2', url: 'https://example.com/b', title: 'Crash tab B', pinned: false, active: false, groupId: -1 },
      { id: 'c3', url: 'https://example.com/c', title: 'Crash tab C', pinned: false, active: false, groupId: -1 },
    ],
    groups: [],
  }],
};

/* ─── capture popup views ─────────────────────────────────────── */
const POPUP_W = 420;
const POPUP_H = 660; // taller crop so one full session card is visible in the shot

const popup = await Page.open(cdp, popupUrl);
await popup.send('Emulation.setDeviceMetricsOverride', { width: POPUP_W, height: POPUP_H, deviceScaleFactor: 2, mobile: false });
await sleep(1400);

const seed = async (extra = {}) => {
  await popup.eval(`chrome.storage.local.set(${JSON.stringify({
    orbi_sessions: [session],
    orbi_settings: { autoSave: true, crashRecovery: true, maxRecoveryPoints: 5 },
    orbi_welcomed: 1,
    ...extra,
  })}).then(() => 1)`);
  await popup.eval(`localStorage.setItem('orbi_welcomed', '1')`);
};

// 01 — dashboard with one session
await seed();
await popup.send('Page.reload');
await sleep(2200);
const shotDashboard = await popup.shot();
console.log('captured dashboard');

// 02 — crash recovery banner
await seed({ recoveryCandidate: crashCandidate, crashDetectedAt: now });
await popup.send('Page.reload');
await sleep(2200);
const shotCrash = await popup.shot();
console.log('captured crash banner');

// 03 — organizer (needs live tabs)
for (const u of ['about:blank#demo-a', 'about:blank#demo-b', 'about:blank#demo-c']) {
  await cdp.send('Target.createTarget', { url: u });
}
await sleep(600);
await seed();
await popup.send('Page.reload');
await sleep(1800);
await popup.eval(CLICK(['Organizer']));
await sleep(1200);
const shotOrganizer = await popup.shot();
console.log('captured organizer');

// 04 — settings → backup & recovery
await popup.eval(CLICK(['Settings']));
await sleep(1200);
await popup.eval(`(() => {
  const el = [...document.querySelectorAll('*')].find((n) => /Backup & Recovery/i.test(n.textContent || '') && n.children.length < 6);
  if (el) el.scrollIntoView({ block: 'start' });
  const scroller = document.querySelector('.custom-scrollbar');
  if (scroller) scroller.scrollTop = scroller.scrollTop + 340;
  return 1;
})()`);
await sleep(1000);
const shotSettings = await popup.shot();
console.log('captured settings');

/* ─── compose 1280x800 listing images ─────────────────────────── */
const BG = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a1018"/>
      <stop offset="0.55" stop-color="#0b1520"/>
      <stop offset="1" stop-color="#0a1a14"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.9" r="0.7">
      <stop offset="0" stop-color="#00e676" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#00e676" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0.1" cy="0.05" r="0.6">
      <stop offset="0" stop-color="#2bb1ff" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#2bb1ff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1280" height="800" fill="url(#bg)"/>
  <rect width="1280" height="800" fill="url(#glow2)"/>
  <rect width="1280" height="800" fill="url(#glow)"/>`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function panel({ eyebrow, title, lines, image, fullBleed = false }) {
  const imgB64 = image.toString('base64');
  const colX = fullBleed ? 700 : 540;

  const bullets = lines.map((l, i) => `
    <g transform="translate(${colX}, ${380 + i * 62})">
      <rect x="0" y="2" width="22" height="22" rx="7" fill="#00e676"/>
      <path d="M6 13.5l3.2 3.2L16.5 9" fill="none" stroke="#062a17" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="38" y="20" fill="#c9d2e3" font-family="Segoe UI, Arial, sans-serif" font-size="20">${esc(l)}</text>
    </g>`).join('');

  // Left tile: the live popup frame, or a cropped page capture for the markup shot.
  const frame = fullBleed
    ? `<g>
         <rect x="46" y="205" width="608" height="383" rx="18" fill="#000" opacity="0.45"/>
         <clipPath id="clipPage"><rect x="40" y="200" width="600" height="375" rx="18"/></clipPath>
         <image x="40" y="200" width="600" height="375" preserveAspectRatio="xMidYMid slice"
                clip-path="url(#clipPage)" href="data:image/png;base64,${imgB64}"/>
         <rect x="40" y="200" width="600" height="375" rx="18" fill="none" stroke="#ffffff" stroke-opacity="0.14"/>
       </g>`
    : `<g>
         <rect x="76" y="62" width="386" height="676" rx="24" fill="#000" opacity="0.45"/>
         <image x="70" y="56" width="386" height="676"
                href="data:image/png;base64,${imgB64}"/>
         <rect x="70" y="56" width="386" height="676" rx="18" fill="none" stroke="#ffffff" stroke-opacity="0.12"/>
       </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
    ${BG}
    ${frame}
    <g transform="translate(${colX}, 150)">
      <rect x="0" y="0" width="34" height="34" rx="10" fill="#2bb1ff"/>
      <text x="46" y="25" fill="#eaf0ff" font-family="Segoe UI, Arial, sans-serif" font-size="17" font-weight="700" letter-spacing="2">ORBITABS</text>
      <text x="0" y="86" fill="#8ab4f8" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" letter-spacing="3">${esc(eyebrow.toUpperCase())}</text>
      <text x="0" y="152" fill="#ffffff" font-family="Segoe UI, Arial, sans-serif" font-size="42" font-weight="700">${esc(title[0])}</text>
      <text x="0" y="202" fill="#00e676" font-family="Segoe UI, Arial, sans-serif" font-size="42" font-weight="700">${esc(title[1])}</text>
    </g>
    ${bullets}
  </svg>`;
}

const shots = [
  {
    file: '01-dashboard-1280x800.png',
    eyebrow: 'Sessions',
    title: ['Save every window,', 'get it back exactly.'],
    lines: ['Windows, tab order, groups, pins', 'One keystroke: Alt+Shift+S', 'Search, folders and tags'],
    image: shotDashboard,
  },
  {
    file: '02-crash-recovery-1280x800.png',
    eyebrow: 'Crash recovery',
    title: ['Chrome crashed?', 'Your tabs are still here.'],
    lines: ['Red badge offers the pre-crash state', 'Live Backup snapshots continuously', 'Recovery points to go further back'],
    image: shotCrash,
  },
  {
    file: '03-organizer-1280x800.png',
    eyebrow: 'Organizer',
    title: ['Real tab control —', 'never automatic.'],
    lines: ['Drag to reorder, drop to group', 'Multi-select and ungroup', 'Nothing moves unless you move it'],
    image: shotOrganizer,
  },
  {
    file: '04-settings-1280x800.png',
    eyebrow: 'Local-first',
    title: ['Your data stays', 'on your device.'],
    lines: ['No account required, works offline', 'No analytics, no trackers', 'Cloud sync opt-in, off by default'],
    image: shotSettings,
  },
];

for (const s of shots) {
  const svg = panel(s);
  const outPath = join(OUT, s.file);
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(outPath);
  const meta = await sharp(outPath).metadata();
  console.log(`✅ ${s.file} — ${meta.width}x${meta.height}`);
}

// Chrome Web Store small promo tile: exactly 440x280, rendered from the SVG
// at 2x and downsampled so the text keeps its antialiasing.
const tileSvg = readFileSync(join(root, 'store-assets/promotional-tile-440x280.svg'));
await sharp(tileSvg, { density: 288 })
  .resize(440, 280, { fit: 'fill' })
  .png({ compressionLevel: 9 })
  .toFile(join(OUT, 'promotional-tile-440x280.png'));
const tileMeta = await sharp(join(OUT, 'promotional-tile-440x280.png')).metadata();
if (tileMeta.width !== 440 || tileMeta.height !== 280) {
  throw new Error(`promo tile is ${tileMeta.width}x${tileMeta.height}, expected 440x280`);
}
console.log(`\u2705 promotional-tile-440x280.png \u2014 ${tileMeta.width}x${tileMeta.height}`);

await popup.close();
await cdp.send('Browser.close').catch(() => {});
chrome.kill();
process.exit(0);
