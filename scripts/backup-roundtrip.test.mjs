// ============================================================================
// BACKUP ROUND-TRIP TEST: export → file → import (unit + store + UI mount)
// Run: node scripts/backup-roundtrip.test.mjs
//
//   1. UNIT     — buildBackupPayload envelope (v1 contract, trash excluded)
//                 + parseBackupText acceptance/rejection matrix
//   2. FILE     — downloadBackupFile produces a real parseable blob
//   3. STORE    — importSessions: fresh ids, additive, originals untouched
//   4. UI       — Settings mounts with Backup & Share; Export button produces
//                 the exact file with only live sessions in it
// ============================================================================

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const throwsWith = async (name, fn, needle) => {
  try { await fn(); ok(name, false, 'did not throw'); }
  catch (e) { ok(name, String(e.message || e).includes(needle), String(e.message || e)); }
};

/* ---------------- jsdom globals (same harness as dashboard-smoke) ---------------- */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'customElements', 'getComputedStyle']) {
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

/* ---------------- chrome.* mock (Settings + store keys) ---------------- */
const stored = {}; // chrome.storage.local backing object
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

const load = (p) => server.ssh = null || server.ssrLoadModule(p);

/* ================================================================== *
 * 1. UNIT — payload builder + parser
 * ================================================================== */
console.log('\n── 1. UNIT: buildBackupPayload + parseBackupText ──');
const { buildBackupPayload, parseBackupText, downloadBackupFile } = await load('/src/popup/utils/sessionBackup.js');
const { importSessions, getSessions } = await load('/src/services/store.js');
const { normalizeSession } = await load('/src/services/sessionSchema.js');

const mkWin = (url, groupId = null) => ({ state: 'normal', focused: true, tabs: [{ url, title: url, pinned: false, active: true, groupId }], groups: [] });
const seedSessions = [
  { _id: 'a', name: 'Alpha', createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z', deletedAt: null, windows: [mkWin('https://alpha.example.com')] },
  { _id: 'b', name: 'Beta', createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z', deletedAt: null, windows: [mkWin('https://beta.example.com')] },
  { _id: 'c', name: 'Trashed', createdAt: '2026-09-03T10:00:00.000Z', deletedAt: '2026-09-04T10:00:00.000Z', windows: [mkWin('https://trash.example.com')] },
];

const payload = buildBackupPayload(seedSessions);
ok('envelope: app/kind/version', payload.app === 'orbitabs' && payload.kind === 'orbitabs-backup' && payload.version === 1);
ok('envelope: count + exportedAt + sessions array', payload.count === 2 && typeof payload.exportedAt === 'string' && payload.sessions.length === 2);
ok('trash EXCLUDED from export', !JSON.stringify(payload).includes('trash.example.com'));
ok('windows carried as v1 (url+groupId)', payload.sessions[0].windows[0].tabs[0].url === 'https://alpha.example.com');

// Round-trip
const round = parseBackupText(JSON.stringify(payload));
ok('round-trip: 2 sessions, 0 skipped', round.sessions.length === 2 && round.skipped === 0);
ok('round-trip: names + createdAt preserved',
  round.sessions.map(s => s.name).join() === 'Alpha,Beta' &&
  round.sessions[0].createdAt === '2026-09-01T10:00:00.000Z');

// Legacy + garbage entries
const legacyDoc = { name: 'Legacy', urls: ['https://old.example.com'], createdAt: '2026-01-01T00:00:00.000Z' };
const mixed = parseBackupText(JSON.stringify({ ...payload, sessions: [...payload.sessions, legacyDoc, { name: 'dead' }, 42, null] }));
ok('legacy urls[] doc accepted via normalizeSession', mixed.sessions.length === 3 && mixed.sessions[2].windows[0].tabs[0].url === 'https://old.example.com');
ok('garbage entries skipped with a count (3)', mixed.skipped === 3);

// Rejection matrix
await throwsWith('rejects non-JSON', () => parseBackupText('not json {'), 'Not a valid JSON file');
await throwsWith('rejects wrong kind', () => parseBackupText(JSON.stringify({ app: 'orbitabs', kind: 'other', version: 1, sessions: [] })), 'not an Orbitabs backup file');
await throwsWith('rejects future version', () => parseBackupText(JSON.stringify({ app: 'orbitabs', kind: 'orbitabs-backup', version: 99, sessions: [] })), 'Unsupported backup version');
await throwsWith('rejects missing sessions array', () => parseBackupText(JSON.stringify({ app: 'orbitabs', kind: 'orbitabs-backup', version: 1 })), 'no sessions array');
await throwsWith('rejects wrong app', () => parseBackupText(JSON.stringify({ app: 'otherapp', kind: 'orbitabs-backup', version: 1, sessions: [] })), 'Unknown backup origin');

/* ================================================================== *
 * 2. FILE — downloadBackupFile yields a real parseable blob
 * ================================================================== */
console.log('\n── 2. FILE: downloadBackupFile ──');
let capturedBlob = null;
const origCreate = URL.createObjectURL?.bind(URL);
URL.createObjectURL = (blob) => { capturedBlob = blob; return 'blob:fake'; };
let filename = null;
try { filename = downloadBackupFile(seedSessions).filename; } finally { if (origCreate) URL.createObjectURL = origCreate; else delete URL.createObjectURL; }
const fileText = capturedBlob ? await capturedBlob.text() : '';
ok('filename is dated (orbitabs-backup-YYYY-MM-DD.json)', /^orbitabs-backup-\d{4}-\d{2}-\d{2}\.json$/.test(filename || ''), filename);
const fileJson = JSON.parse(fileText);
ok('file content parses back to the same 2 sessions', fileJson.count === 2 && parseBackupText(fileText).sessions.length === 2);

/* ================================================================== *
 * 3. STORE — importSessions is additive with fresh ids
 * ================================================================== */
console.log('\n── 3. STORE: importSessions ──');
stored.orbi_sessions = [
  { _id: 'existing', name: 'Existing', createdAt: '2026-08-01T00:00:00.000Z', deletedAt: null, windows: [mkWin('https://existing.example.com')] },
  // deleted YESTERDAY — inside the 30-day retention window (the store auto-purges older trash)
  { _id: 'recent-trash', name: 'RecentTrash', createdAt: '2026-09-09T00:00:00.000Z', deletedAt: new Date(Date.now() - 86400000).toISOString(), windows: [mkWin('https://t.example.com')] },
];
const { imported, skipped } = await importSessions(mixed);
ok('imported=3, skipped=3 (same mixed file)', imported === 3 && skipped === 3);
const after = (await getSessions()).data;
ok('store now holds 4 live sessions (3 imported + 1 existing)', after.length === 4);
ok('all ids fresh (imports never reuse source doc ids)', after.every(s => !['a', 'b'].includes(s._id || s.id)) && new Set(after.map(s => s._id || s.id)).size === 4);
ok('originals untouched (Existing live, RecentTrash still in trash with original id)',
  after.some(s => s.name === 'Existing') &&
  stored.orbi_sessions.some(s => s._id === 'recent-trash' && s.deletedAt));
ok('imported names landed', after.filter(s => ['Alpha', 'Beta', 'Legacy'].includes(s.name)).length === 3);
ok('imports are marked user sessions (isAutoSave=false)', after.filter(s => ['Alpha', 'Beta'].includes(s.name)).every(s => s.isAutoSave === false));

/* ================================================================== *
 * 3b. IMPORT EDGE CASES — duplicates, invalid entries, version skew
 * ================================================================== */
console.log('\n── 3b. IMPORT EDGE CASES ──');
stored.orbi_sessions = [seedSessions[0]]; // Alpha already lives in the store
const dupFile = parseBackupText(JSON.stringify(payload));
const dupRes = await importSessions(dupFile);
ok('duplicate import: imported=1, duplicates=1 (Beta new, Alpha already present)', dupRes.imported === 1 && dupRes.duplicates === 1);
const dupRes2 = await importSessions(dupFile);
ok('re-importing the same file again is a full no-op (no copies pile up)', dupRes2.imported === 0 && dupRes2.duplicates === 2);

// Garbage entries never crash the import — skipped and counted (beta gate)
stored.orbi_sessions = [];
const junk = parseBackupText(JSON.stringify({
  ...payload,
  sessions: [null, 42, 'str', [], {}, { name: 'ok', windows: [mkWin('https://junk-ok.example.com')] }],
}));
const junkRes = await importSessions(junk);
ok('garbage entries (null/42/"str"/[]/{}) skipped without crashing', junkRes.imported === 1 && junkRes.skipped === 5);
ok('the one valid entry still landed with its data', (await getSessions()).data.some(s => s.name === 'ok' && s.windows[0].tabs[0].url === 'https://junk-ok.example.com'));

// Future-version file: rejected with actionable guidance (UI shows it verbatim)
await throwsWith('future version rejected with update guidance',
  () => parseBackupText(JSON.stringify({ ...payload, version: 2 })), 'NEWER version of Orbitabs');

// Valid-but-empty file imports nothing, cleanly
const emptyRes = await importSessions(parseBackupText(JSON.stringify({ ...payload, sessions: [] })));
ok('empty sessions[] imports nothing cleanly', emptyRes.imported === 0);

/* ================================================================== *
 * 3c. IMPORT SAFETY — bad files must NEVER touch existing data
 * ================================================================== */
console.log('\n── 3c. IMPORT SAFETY: duplicate / invalid / unknown-version ──');
// The user's precious data: 2 live + 1 in-trash session.
stored.orbi_sessions = [
  { _id: 'keep-1', name: 'KeepA', createdAt: '2026-08-01T00:00:00.000Z', deletedAt: null, windows: [mkWin('https://keep-a.example.com')] },
  { _id: 'keep-2', name: 'KeepB', createdAt: '2026-08-02T00:00:00.000Z', deletedAt: null, windows: [mkWin('https://keep-b.example.com')] },
  { _id: 'keep-trash', name: 'KeepTrash', createdAt: '2026-08-03T00:00:00.000Z', deletedAt: new Date(Date.now() - 86400000).toISOString(), windows: [mkWin('https://keep-t.example.com')] },
];
const snap = () => JSON.stringify(stored.orbi_sessions);

// A. REJECTED FILES — every bad envelope throws BEFORE any store write
const env = (over) => JSON.stringify({ app: 'orbitabs', kind: 'orbitabs-backup', version: 1, sessions: [], ...over });
const badFiles = [
  ['non-JSON garbage', 'oops {{{', 'Not a valid JSON file'],
  ['JSON scalar (number)', '42', 'not a backup object'],
  ['JSON null', 'null', 'not a backup object'],
  ['JSON array instead of object', '[1,2,3]', 'not an Orbitabs backup'],
  ['missing kind field', JSON.stringify({ app: 'orbitabs', version: 1, sessions: [] }), 'not an Orbitabs backup'],
  ['foreign app name', env({ app: 'otherapp' }), 'Unknown backup origin'],
  ['unknown version 99', env({ version: 99 }), 'NEWER version of Orbitabs'],
  ['unknown version 2', env({ version: 2 }), 'NEWER version of Orbitabs'],
  ['version as string "1"', env({ version: '1' }), 'unrecognized format'],
  ['negative version -1', env({ version: -1 }), 'unrecognized format'],
  ['missing version', JSON.stringify({ app: 'orbitabs', kind: 'orbitabs-backup', sessions: [] }), 'Unsupported backup version'],
  ['sessions not an array', env({ sessions: 'nope' }), 'no sessions array'],
  ['missing sessions array', JSON.stringify({ app: 'orbitabs', kind: 'orbitabs-backup', version: 1 }), 'no sessions array'],
];
const beforeBad = snap();
for (const [label, text, needle] of badFiles) {
  await throwsWith(`rejects ${label}`, () => parseBackupText(text), needle);
}
ok('store BYTE-IDENTICAL after all 13 rejected files', snap() === beforeBad);

// B. ALL-INVALID file — parse succeeds but nothing is importable → no write
const allJunk = parseBackupText(env({ sessions: [null, 42, 'str', [], {}, { name: 'dead' }, { name: 'win-garbage', windows: 'nope' }] }));
ok('all-invalid file: 0 sessions survive the parser, 7 counted skipped', allJunk.sessions.length === 0 && allJunk.skipped === 7);
const junkRes2 = await importSessions(allJunk);
ok('all-invalid import is a no-op (imported=0)', junkRes2.imported === 0);
ok('store BYTE-IDENTICAL after all-invalid import', snap() === beforeBad);

// B2. Direct calls with garbage input (defensive: bypasses the parser)
const directs = [null, undefined, {}, { sessions: null }, { sessions: 'x' }];
let directOk = true;
for (const arg of directs) {
  const r = await importSessions(arg);
  if (r.imported !== 0 || r.duplicates !== 0) directOk = false;
}
ok('importSessions(null/undefined/{}/bad-shape) → {imported:0}, no crash', directOk);
ok('store BYTE-IDENTICAL after direct garbage calls', snap() === beforeBad);

// C. UNKNOWN session-level schemaVersion inside a VALID envelope
const futureDoc = { name: 'FutureDoc', schemaVersion: 99, windows: [mkWin('https://future.example.com')] };
const futureParsed = parseBackupText(env({ sessions: [futureDoc] }));
ok('unknown session schemaVersion=99 is normalized to v1 (not rejected, not stored raw)',
  futureParsed.sessions.length === 1 && futureParsed.sessions[0].schemaVersion === 1);
const futureRes = await importSessions(futureParsed);
const storedFuture = (await getSessions()).data.find(s => s.name === 'FutureDoc');
ok('unknown-version doc LANDS + round-trips the locked schema',
  futureRes.imported === 1 && !!storedFuture &&
  !!normalizeSession(storedFuture) &&
  normalizeSession(storedFuture).windows[0].tabs[0].url === 'https://future.example.com');

// D. DUPLICATE gate: same name + DIFFERENT createdAt → new session (no false dedupe)
stored.orbi_sessions = [seedSessions[0]]; // Alpha @ 2026-09-01 already lives here
const sameName = JSON.stringify({ ...payload, sessions: [
  { name: 'Alpha', createdAt: '2026-05-05T00:00:00.000Z', windows: [mkWin('https://alpha-reissue.example.com')] },
] });
const snr = await importSessions(parseBackupText(sameName));
const alphas = (await getSessions()).data.filter(s => s.name === 'Alpha');
ok('same name + different createdAt → imported (dedupe needs BOTH)', snr.imported === 1 && alphas.length === 2);
const snr2 = await importSessions(parseBackupText(sameName));
ok('re-import of that file → exact duplicate skipped', snr2.imported === 0 && snr2.duplicates === 1);
ok('Alpha store content unchanged by the duplicate re-import',
  (await getSessions()).data.filter(s => s.name === 'Alpha').length === 2);

// E. MIXED file against a populated store — valid lands, junk skipped, existing + trash intact
stored.orbi_sessions = [
  { _id: 'keep-1', name: 'KeepA', createdAt: '2026-08-01T00:00:00.000Z', deletedAt: null, windows: [mkWin('https://keep-a.example.com')] },
  { _id: 'keep-trash', name: 'KeepTrash', createdAt: '2026-08-03T00:00:00.000Z', deletedAt: new Date(Date.now() - 86400000).toISOString(), windows: [mkWin('https://keep-t.example.com')] },
  seedSessions[0], // Alpha already lives here → the mixed file's Alpha entry must DEDUPE
];
const mixedRes = await importSessions(parseBackupText(env({ sessions: [
  'garbage',
  { name: 'Alpha', createdAt: '2026-09-01T10:00:00.000Z', windows: [mkWin('https://alpha.example.com')] }, // duplicate
  { name: 'Fresh', createdAt: '2026-10-01T00:00:00.000Z', windows: [mkWin('https://fresh.example.com')] },  // valid
  { windows: [] },                                                                                        // dead
] })));
const finalStore = stored.orbi_sessions;
ok('mixed file: 1 imported, 1 duplicate, 2 dead skipped',
  mixedRes.imported === 1 && mixedRes.duplicates === 1 && mixedRes.skipped === 2);
ok('existing live session untouched (same id, same content)',
  finalStore.some(s => s._id === 'keep-1' && s.name === 'KeepA' && s.windows[0].tabs[0].url === 'https://keep-a.example.com'));
ok('trash session STILL in trash (import never touches deletedAt)',
  finalStore.some(s => s._id === 'keep-trash' && s.deletedAt));
ok('no id collisions: every store id unique after imports',
  new Set(finalStore.map(s => s._id)).size === finalStore.length);

/* ================================================================== *
 * 4. UI — Settings page Backup & Share section
 * ================================================================== */
console.log('\n── 4. UI: Settings Backup & Share ──');
const { default: Settings } = await load('/src/popup/pages/Settings.jsx');
const React = require('react');

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const act = (fn) => require('react-dom/test-utils').act(fn);
const fire = (el, type) => el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, view: dom.window }));

// Seed the store the popup reads: 2 live + 1 trashed
stored.orbi_sessions = seedSessions;

const container = dom.window.document.getElementById('root');
const rootEl = require('react-dom/client').createRoot(container);
await act(async () => { rootEl.render(React.createElement(Settings, { cloudUser: null, theme: 'light', onCycleTheme: () => {}, onBack: () => {} })); });
await tick(100);

const byText = (selector, text) => [...document.querySelectorAll(selector)].filter(el => el.textContent.trim().includes(text));
ok('Privacy & Data section renders (export/import live there now)', byText('h2', 'Privacy & Data').length > 0);
const exportBtn = byText('button', 'Export all data')[0];
const importBtn = byText('button', 'Import data')[0];
ok('Export all data + Import data buttons render', !!exportBtn && !!importBtn);

// Drive EXPORT through the real button → real downloadBackupFile
capturedBlob = null;
URL.createObjectURL = (blob) => { capturedBlob = blob; return 'blob:fake'; };
await act(async () => { fire(exportBtn, 'click'); });
await tick(150);
if (origCreate) URL.createObjectURL = origCreate; else delete URL.createObjectURL;
const uiText = capturedBlob ? await capturedBlob.text() : '';
const uiJson = JSON.parse(uiText);
ok('UI Export produced the backup file (2 live sessions, trash excluded)', uiJson.count === 2 && !uiText.includes('trash.example.com'));
ok('status line shows export success', document.body.textContent.includes('Exported 2 sessions'));

/* ------------------------------------------------------------------ *
 * RESULT
 * ------------------------------------------------------------------ */
console.log(`\n✅ BACKUP ROUND-TRIP: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
