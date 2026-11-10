// ============================================================================
// V1.5 METADATA + RESTORE PREVIEW TEST
// -----------------------------------
// Run: node scripts/metadata-preview.test.mjs
//
//   1. SCHEMA  — sanitizeTags matrix + normalizeSession carries tags/note/folder
//   2. STORE   — setSessionMeta (partial updates, not-found, updatedAt bump),
//                createSession + duplicate keep metadata, import round-trip
//   3. BACKUP  — buildBackupPayload exports metadata; garbage tags sanitized
//   4. SEARCH  — tags/note/folder are searchable
//   5. WORKER  — sync push/pull/LWW carry metadata (real background.js, VM)
//   6. UI      — SessionList chips + ⋯ menu (Preview/Organize), meta modal
//                save flow, preview modal compare math + honest copy
// ============================================================================

import vm from 'node:vm';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerCode = readFileSync(join(root, 'public/background.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- jsdom globals (UI mount) ---------------- */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Event', 'KeyboardEvent', 'MouseEvent', 'customElements', 'getComputedStyle', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* ---------------- vite SSR loader ---------------- */
const vite = await import('vite');
const server = await vite.createServer({
  root, configFile: false, plugins: [],
  optimizeDeps: { disabled: true },
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom', logLevel: 'error',
});
const load = (p) => server.ssrLoadModule(p);

/* ---------------- chrome.storage mock ---------------- */
const stored = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in stored) out[k] = stored[k]; });
        return out;
      },
      set: async (obj) => { Object.assign(stored, obj); },
      remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete stored[k]); },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
  runtime: { sendMessage: async () => ({ ok: false }), onMessage: { addListener() {} }, lastError: null },
};

const mkWin = (url, groupId = null, pinned = false) => ({
  state: 'normal', focused: true,
  tabs: [{ url, title: url, pinned, active: true, groupId }],
  groups: []
});

/* ================================================================== *
 * 1. SCHEMA — sanitize + normalize carry metadata
 * ================================================================== */
console.log('\n── 1. SCHEMA ──');
const { sanitizeTags, normalizeSession, MAX_TAGS, MAX_NOTE_LEN } = await load('/src/services/sessionSchema.js');

ok('sanitizeTags: garbage → []', JSON.stringify(sanitizeTags(null)) === '[]' && JSON.stringify(sanitizeTags('x')) === '[]' && JSON.stringify(sanitizeTags(42)) === '[]');
ok('sanitizeTags: trims + drops empties + exact-dupes', JSON.stringify(sanitizeTags([' a ', 'a', '', '  ', 'b', 7, null])) === '["a","b"]', JSON.stringify(sanitizeTags([' a ', 'a', '', '  ', 'b', 7, null])));
{
  const many = Array.from({ length: 50 }, (_, i) => `tag${i}`);
  ok(`sanitizeTags: capped at MAX_TAGS (${MAX_TAGS})`, sanitizeTags(many).length === MAX_TAGS);
  const long = sanitizeTags(['x'.repeat(200)]);
  ok('sanitizeTags: per-tag length capped at 40', long[0].length === 40);
}

const taggedDoc = {
  _id: 't1', name: 'Tagged', windows: [mkWin('https://a.example')],
  tags: ['work', 'read-later', 'work'], note: '  my note  ', folder: '  Projects  ',
  createdAt: '2026-10-01T00:00:00.000Z',
};
{
  const v1 = normalizeSession(taggedDoc);
  ok('normalize: tags carried + deduped', JSON.stringify(v1.tags) === '["work","read-later"]', JSON.stringify(v1.tags));
  ok('normalize: note carried (sliced, not trimmed)', v1.note === '  my note  '.slice(0, MAX_NOTE_LEN), JSON.stringify(v1.note));
  ok('normalize: folder trimmed', v1.folder === 'Projects');
}
{
  const legacy = normalizeSession({ name: 'Old', urls: ['https://old.example'] });
  ok('normalize: legacy doc → clean defaults (tags [], note "", folder null)',
    Array.isArray(legacy.tags) && legacy.tags.length === 0 && legacy.note === '' && legacy.folder === null,
    JSON.stringify({ t: legacy.tags, n: legacy.note, f: legacy.folder }));
}
{
  const v1 = normalizeSession({ name: 'Bad', urls: ['https://x.example'], tags: [1, {}, 'ok', ''], note: 42, folder: 9 });
  ok('normalize: hostile metadata types sanitized safely',
    JSON.stringify(v1.tags) === '["ok"]' && v1.note === '' && v1.folder === null,
    JSON.stringify({ t: v1.tags, n: v1.note, f: v1.folder }));
}

/* ================================================================== *
 * 2. STORE — setSessionMeta + create/duplicate/import
 * ================================================================== */
console.log('\n── 2. STORE ──');
const store = await load('/src/services/store.js');
await globalThis.chrome.storage.local.remove('orbi_sessions');

const created = await store.createSession({ name: 'Meta target', windows: [mkWin('https://m.example')] });
const cid = created.data._id;

{
  const before = created.data.updatedAt;
  await sleep(5);
  const r = await store.setSessionMeta(cid, { tags: ['alpha', 'beta'], note: 'remember this', folder: 'Work' });
  ok('setSessionMeta: writes all three fields', r.data.tags.join() === 'alpha,beta' && r.data.note === 'remember this' && r.data.folder === 'Work', JSON.stringify(r.data));
  ok('setSessionMeta: bumps updatedAt (sync LWW sees the edit)', new Date(r.data.updatedAt).getTime() > new Date(before).getTime());
}
{
  const r = await store.setSessionMeta(cid, { tags: ['solo'] }); // partial — note/folder untouched
  ok('setSessionMeta: partial update leaves other fields', r.data.tags.join() === 'solo' && r.data.note === 'remember this' && r.data.folder === 'Work', JSON.stringify(r.data));
}
{
  const r = await store.setSessionMeta('nope', { tags: ['x'] });
  ok('setSessionMeta: unknown id → not-found (no silent create)', r.error === 'not-found');
}
{
  const r = await store.setSessionMeta(cid, { folder: null, note: '' });
  ok('setSessionMeta: null folder / empty note clear the fields', r.data.folder === null && r.data.note === '');
}
{
  await store.setSessionMeta(cid, { tags: ['keepme'], folder: 'F1', note: 'n1' });
  const dup = await store.duplicateSession(cid);
  ok('duplicateSession: metadata travels to the copy',
    dup.data.tags.join() === 'keepme' && dup.data.folder === 'F1' && dup.data.note === 'n1', JSON.stringify(dup.data));
}
{
  const list = await store.getSessions();
  const doc = list.data.find(s => s._id === cid);
  ok('getSessions: normalized view still carries metadata', doc.tags.join() === 'keepme' && doc.folder === 'F1');
}

/* ================================================================== *
 * 3. BACKUP — export/import round-trip
 * ================================================================== */
console.log('\n── 3. BACKUP ──');
const { buildBackupPayload, parseBackupText } = await load('/src/popup/utils/sessionBackup.js');
{
  const list = await store.getSessions();
  const payload = buildBackupPayload(list.data);
  const entry = payload.sessions.find(s => s.name === 'Meta target');
  ok('export: tags/note/folder in the payload', entry && entry.tags.join() === 'keepme' && entry.note === 'n1' && entry.folder === 'F1', JSON.stringify(entry));
  ok('export: contract fields untouched (kind/version/count)', payload.kind === 'orbitabs-backup' && payload.version === 1 && payload.count === list.data.length);

  // Round-trip through the parser, then import into a CLEAN store
  const parsed = parseBackupText(JSON.stringify(payload));
  ok('parse: metadata survives the file round-trip',
    parsed.sessions.some(s => s.tags.join() === 'keepme' && s.folder === 'F1' && s.note === 'n1'),
    JSON.stringify(parsed.sessions.map(s => [s.name, s.tags, s.folder])));

  const backupKey = 'orbi_sessions';
  const saved = stored[backupKey];
  stored[backupKey] = []; // wipe = second machine
  const res = await store.importSessions(parsed);
  const imported = stored[backupKey].find(s => s.name === 'Meta target');
  ok('import: metadata restored on the new machine', imported && imported.tags.join() === 'keepme' && imported.folder === 'F1' && imported.note === 'n1', JSON.stringify(imported));
  ok('import: additive + fresh ids (no overwrite of existing)', res.imported === parsed.sessions.length && imported._id !== cid);

  // Hostile metadata in a hand-edited file never lands raw
  const evil = parseBackupText(JSON.stringify({
    app: 'orbitabs', kind: 'orbitabs-backup', version: 1,
    sessions: [{ name: 'Evil', windows: [mkWin('https://e.example')], tags: [1, 'real', '', 'real'], note: { a: 1 }, folder: 42 }]
  }));
  const ev = evil.sessions[0];
  ok('parse: hostile metadata sanitized (tags ["real"], note "", folder null)',
    JSON.stringify(ev.tags) === '["real"]' && ev.note === '' && ev.folder === null,
    JSON.stringify({ t: ev.tags, n: ev.note, f: ev.folder }));
  stored[backupKey] = saved; // restore for the UI section
}

/* ================================================================== *
 * 4. SEARCH — tags/note/folder match like name/url
 * ================================================================== */
console.log('\n── 4. SEARCH ──');
const { sessionMatchesQuery, filterSessions } = await load('/src/popup/utils/sessionSearch.js');
{
  const s = { name: 'Plain name', windows: [mkWin('https://site.example/page')], tags: ['Design', 'inspiration'], note: 'fonts to try', folder: 'Creative' };
  ok('search: tag match', sessionMatchesQuery(s, 'design'));
  ok('search: note match', sessionMatchesQuery(s, 'FONTS'));
  ok('search: folder match', sessionMatchesQuery(s, 'creative'));
  ok('search: url match still works', sessionMatchesQuery(s, 'site.example/page'));
  ok('search: no match on absent text', !sessionMatchesQuery(s, 'zzz'));
  const list = [{ name: 'A', windows: [mkWin('https://a.example')], tags: ['x'] }, { name: 'B', windows: [mkWin('https://b.example')], tags: ['y'] }];
  ok('filterSessions: tag-based filtering', filterSessions(list, 'y').length === 1 && filterSessions(list, 'y')[0].name === 'B');
}

/* ================================================================== *
 * 5. WORKER — sync carries metadata both ways (real background.js)
 * ================================================================== */
console.log('\n── 5. WORKER SYNC ──');
function createChromeMock() {
  const state = { local: {}, messageListener: null };
  const chrome = {
    commands: { onCommand: { addListener() {} } },
    windows: { onCreated: { addListener() {} }, onRemoved: { addListener() {} }, async getAll() { return []; }, async getCurrent() { return null; } },
    tabs: {
      onCreated: { addListener() {} }, onRemoved: { addListener() {} }, onMoved: { addListener() {} },
      onAttached: { addListener() {} }, onDetached: { addListener() {} }, onReplaced: { addListener() {} }, onUpdated: { addListener() {} },
      async create() { throw new Error('not needed'); }, async query() { return []; }, async update() {}, async group() { return 1; }, async ungroup() {},
    },
    tabGroups: { onCreated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, async query() { return []; }, async update() {} },
    storage: {
      local: {
        async get(keys) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in state.local) out[k] = state.local[k]; }); return out; },
        async set(obj) { Object.assign(state.local, obj); },
        async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete state.local[k]); },
      },
      session: { async get() { return {}; }, async set() {} },
      onChanged: { addListener() {}, removeListener() {} },
    },
    alarms: { create() {}, clear() {}, async getAll() { return []; }, onAlarm: { addListener() {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    runtime: { onMessage: { addListener(cb) { state.messageListener = cb; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, async sendMessage() { return { ok: false }; } },
  };
  return { chrome, state };
}
function makeFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const path = u.replace(/^https?:\/\/[^/]+/, '');
    const h = routes(path, opts, calls);
    if (h === 'throw') throw new Error('ECONNREFUSED');
    return { ok: h.status >= 200 && h.status < 300, status: h.status, json: async () => h.data };
  };
  f.calls = calls;
  return f;
}
const loadWorker = (mock, fetchImpl) => {
  const sandbox = { chrome: mock.chrome, console, setTimeout, clearTimeout, Date, JSON, AbortSignal, URL, fetch: fetchImpl };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });
};
async function sendMessage(mock, msg) {
  let response = null;
  mock.state.messageListener(msg, {}, (r) => { response = r; });
  for (let i = 0; i < 150 && response === null; i++) await sleep(10);
  return response;
}
const localDoc = (id, over = {}) => ({
  _id: id, name: `Session ${id}`, windows: [mkWin('https://a.example')], schemaVersion: 1,
  isAutoSave: false, autoKey: null, deletedAt: null, tags: [], note: '', folder: null,
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});
const syncOn = { cloudSync: true, localOnly: false, autoSave: true };

{
  // PUSH: tagged local doc → POST body carries tags/note/folder
  const mock = createChromeMock();
  const fetch5 = makeFetch((path, opts) => opts.method === 'POST' ? { status: 200, data: { _id: 'c1' } } : { status: 200, data: [] });
  loadWorker(mock, fetch5);
  mock.state.local.orbi_settings = { ...syncOn };
  mock.state.local.token = 'jwt';
  mock.state.local.orbi_sessions = [localDoc('p1', { tags: ['research', 'pdf'], note: 'thesis sources', folder: 'Uni' })];
  await sendMessage(mock, { type: 'SYNC_NOW' });
  const post = fetch5.calls.find(c => c.method === 'POST');
  ok('push: POST body carries tags/note/folder',
    post && post.body.tags.join() === 'research,pdf' && post.body.note === 'thesis sources' && post.body.folder === 'Uni',
    JSON.stringify(post?.body));
}
{
  // PULL: cloud doc with metadata → local copy keeps it
  const mock = createChromeMock();
  const fetch6 = makeFetch((path) => path === '/api/sessions'
    ? { status: 200, data: [{ _id: 'cx', name: 'From cloud', windows: [mkWin('https://c.example')], tags: ['cloudtag'], note: 'cloud note', folder: 'CloudF', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' }] }
    : { status: 200, data: {} });
  loadWorker(mock, fetch6);
  mock.state.local.orbi_settings = { ...syncOn };
  mock.state.local.token = 'jwt';
  mock.state.local.orbi_sessions = [];
  await sendMessage(mock, { type: 'SYNC_NOW' });
  const pulled = mock.state.local.orbi_sessions.find(s => s.cloudId === 'cx');
  ok('pull: metadata adopted on the new device',
    pulled && pulled.tags.join() === 'cloudtag' && pulled.note === 'cloud note' && pulled.folder === 'CloudF',
    JSON.stringify(pulled));
}
{
  // LWW (cloud newer): adopt name AND metadata together
  const mock = createChromeMock();
  const cloud = { _id: 'c9', name: 'Renamed cloud', windows: [mkWin('https://c9.example')], tags: ['newertag'], note: 'newer note', folder: 'NF', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z' };
  const fetch7 = makeFetch((path) => path === '/api/sessions' ? { status: 200, data: [cloud] } : { status: 200, data: {} });
  loadWorker(mock, fetch7);
  mock.state.local.orbi_settings = { ...syncOn };
  mock.state.local.token = 'jwt';
  mock.state.local.orbi_sessions = [localDoc('L1', { name: 'Old name', cloudId: 'c9', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T01:00:00.000Z', tags: ['oldtag'] })];
  await sendMessage(mock, { type: 'SYNC_NOW' });
  const doc = mock.state.local.orbi_sessions.find(s => s.cloudId === 'c9');
  ok('LWW (cloud newer): tags/note/folder adopted with the rename',
    doc.name === 'Renamed cloud' && doc.tags.join() === 'newertag' && doc.note === 'newer note' && doc.folder === 'NF',
    JSON.stringify(doc));
}

/* ================================================================== *
 * 6. UI — cards, menus, meta modal, preview modal
 * ================================================================== */
console.log('\n── 6. UI (SessionList + modals) ──');
// React comes from plain require (CJS) — same as dashboard-smoke; only the
// JSX components load through vite SSR.
const React = require('react');
const { createRoot } = require('react-dom/client');
const act = (fn) => require('react-dom/test-utils').act(fn);
const SessionList = (await load('/src/popup/components/dashboard/SessionList.jsx')).default;
const RestorePreviewModal = (await load('/src/popup/components/dashboard/RestorePreviewModal.jsx')).default;
const SessionMetaModal = (await load('/src/popup/components/dashboard/SessionMetaModal.jsx')).default;

const host = document.createElement('div');
document.body.appendChild(host);
const fire = (el, type) => el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true }));
const byText = (sel, text) => [...document.querySelectorAll(sel)].filter(e => (e.textContent || '').includes(text));
// React 18 controlled inputs: a direct .value write trips the value tracker
// and onChange never fires — go through the NATIVE prototype setter, then
// dispatch a real 'input' event (the standard testing-library workaround).
const type = (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};

let reloads = 0;
const uiSessions = [
  localDoc('ui1', { name: 'Tagged card', tags: ['work', 'deep'], folder: 'Projects', note: 'quarterly planning links', pinned: false }),
  localDoc('ui2', { name: 'Plain card' }),
];
// The cards render from PROPS, but Organize saves through the real store —
// seed the backing storage so the save path is end-to-end, not a not-found.
stored.orbi_sessions = uiSessions.map(s => structuredClone(s));

await act(async () => {
  createRoot(host).render(React.createElement(SessionList, {
    sessions: uiSessions, onDelete: () => {}, onRenamed: () => { reloads++; }, onRestoreResult: () => {},
  }));
});

ok('card shows tag chips (#work)', byText('span', '#work').length > 0);
ok('card shows the folder badge', byText('span', 'Projects').length > 0);
ok('card shows the note preview', byText('span', 'quarterly planning links').length > 0);
ok('plain card shows no metadata clutter', byText('h4', 'Plain card')[0] && !byText('h4', 'Plain card')[0].parentElement.parentElement.textContent.includes('#'));

// ⋯ menu → Preview + Organize present
let menuBtns = [...document.querySelectorAll('button[title="More actions"]')];
await act(async () => { fire(menuBtns[0], 'click'); });
ok('⋯ menu offers Preview', byText('button', 'Preview').length > 0);
ok('⋯ menu offers Organize…', byText('button', 'Organize…').length > 0);

// Organize → meta modal opens with current values → edit + save
await act(async () => { fire(byText('button', 'Organize…')[0], 'click'); });
{
  const modalTitle = byText('h3', 'Organize session');
  ok('meta modal opens', modalTitle.length === 1);
  const tagInput = document.querySelector('input[placeholder^="Add a tag"]');
  const folderInput = document.querySelector('input[list="orbitabs-folders"]');
  const textarea = document.querySelector('textarea');
  ok('meta modal prefilled (tag chips, folder, note)',
    byText('span', 'work').length > 0 && folderInput?.value === 'Projects' && textarea?.value === 'quarterly planning links',
    JSON.stringify({ f: folderInput?.value, n: textarea?.value }));
  ok('folder datalist offers existing folders', [...document.querySelectorAll('#orbitabs-folders option')].some(o => o.value === 'Projects'));

  // add a tag via Enter, change folder, save
  await act(async () => {
    type(tagInput, 'newtag');
    tagInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    type(folderInput, 'Archive');
  });
  await act(async () => { fire(byText('button', 'Save')[0], 'click'); });
}
{
  const saved = stored.orbi_sessions.find(s => s.name === 'Tagged card');
  ok('meta modal save → store updated (tags+folder)',
    saved && saved.tags.join() === 'work,deep,newtag' && saved.folder === 'Archive' && saved.note === 'quarterly planning links',
    JSON.stringify(saved));
  ok('meta modal closed after save', byText('h3', 'Organize session').length === 0);
  ok('onRenamed fired (list refresh path)', reloads > 0);
}

// Preview modal — structure + compare math + honest copy
{
  const previewHost = document.createElement('div');
  document.body.appendChild(previewHost);
  const session = {
    name: 'Preview me', schemaVersion: 1,
    windows: [
      { state: 'normal', focused: true, groups: [{ id: 'g1', title: 'Docs', color: 'blue', collapsed: false }],
        tabs: [
          { url: 'https://open.example/', title: 'Open', pinned: false, active: true, groupId: 'g1' },
          { url: 'https://new.example/page/', title: 'New', pinned: true, active: false, groupId: null },
        ] },
    ],
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  // live windows contain the first URL WITHOUT the trailing slash — compare must match
  const live = [{ tabs: [{ url: 'https://open.example' }] }];
  let restored = null;
  await act(async () => {
    createRoot(previewHost).render(React.createElement(RestorePreviewModal, {
      open: true, session, liveWindows: live,
      onRestore: (s) => { restored = s; }, onCancel: () => {},
    }));
  });
  const text = previewHost.textContent;
  ok('preview: structure summary (1 window · 2 tabs · 1 group)',
    /1 window/.test(text) && /2 tabs/.test(text) && /1 group/.test(text), text.slice(0, 200));
  ok('preview: group chip shown', text.includes('Docs'));
  ok('preview: pinned marker shown', text.includes('pinned'));
  ok('preview: honest overlap copy (1 of 2 already open)', /1 of these 2 tabs are already open/.test(text), text.slice(0, 300));
  ok('preview: open tab flagged', text.includes('open'));
  const restoreBtn = [...previewHost.querySelectorAll('button')].find(b => /Restore/.test(b.textContent));
  ok('preview: restore CTA counts new tabs (Restore 2 tabs (1 new))',
    restoreBtn && /Restore 2 tabs \(1 new\)/.test(restoreBtn.textContent), restoreBtn?.textContent);
  await act(async () => { fire(restoreBtn, 'click'); });
  ok('preview: restore hands back the normalized session', restored && restored.name === 'Preview me' && restored.windows.length === 1);

  // Compare-unavailable path (fresh profile, no live capture → []): no overlap copy, restore still offered
  await act(async () => {
    createRoot(previewHost).render(React.createElement(RestorePreviewModal, {
      open: true, session, liveWindows: [], onRestore: () => {}, onCancel: () => {},
    }));
  });
  const t2 = previewHost.textContent;
  ok('preview: without live windows, no false "already open" claims', !/already open/.test(t2) && /Restore 2 tabs/.test(t2), t2.slice(0, 200));

  // Meta modal closed state renders nothing
  await act(async () => {
    createRoot(previewHost).render(React.createElement(SessionMetaModal, { open: false, session: null, onSave: () => {}, onCancel: () => {} }));
  });
  ok('meta modal: open=false renders nothing', previewHost.textContent === '');
}

await server.close();

console.log(`\n════════════════════════════════════════════════`);
console.log(`  METADATA + PREVIEW: ${pass} passed, ${fail} failed`);
console.log(`════════════════════════════════════════════════\n`);
process.exit(fail > 0 ? 1 : 0);
