// Orbitabs — automated schema verification (Task 15, automated part)
// Run: node scripts/verify-schema.mjs
// Tests the LOCKED Session Snapshot v1 module end-to-end without Chrome.

import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaUrl = pathToFileURL(join(root, 'src/services/sessionSchema.js')).href;

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

const { normalizeSession, captureAllWindowsV1, SCHEMA_VERSION } = await import(schemaUrl);

console.log('\n=== Orbitabs Session Snapshot v1 — verification ===\n');

/* 1. v1 round-trip: save shape → normalize → same structure */
const v1doc = {
  _id: 'a1', name: 'Work',
  windows: [{
    state: 'maximized', focused: true,
    tabs: [
      { url: 'https://github.com', title: 'GitHub', pinned: true, active: false, groupId: 'g1' },
      { url: 'https://mail.google.com', title: 'Gmail', pinned: false, active: true, groupId: 'g1' },
      { url: 'https://youtube.com', title: 'YT', pinned: false, active: false, groupId: null }
    ],
    groups: [{ id: 'g1', title: 'Work', color: 'red', collapsed: true }]
  }],
  createdAt: '2026-09-08T10:00:00Z'
};
const r1 = normalizeSession(v1doc);
check('v1 pass-through: windows preserved', r1?.windows?.length === 1);
check('v1 pass-through: pinned flag kept', r1.windows[0].tabs[0].pinned === true);
check('v1 pass-through: active flag kept', r1.windows[0].tabs[1].active === true);
check('v1 pass-through: membership kept (tab→g1)', r1.windows[0].tabs[1].groupId === 'g1');
check('v1 pass-through: group meta kept', r1.windows[0].groups[0].title === 'Work'
  && r1.windows[0].groups[0].color === 'red' && r1.windows[0].groups[0].collapsed === true);
check('v1 pass-through: internal _windowId stripped', !('_windowId' in r1.windows[0]));

/* 2. Legacy migration: {urls, groups[].urlIndices} → v1 membership */
const legacy = {
  _id: 'a2', name: 'Legacy',
  urls: ['https://a.com', 'https://b.com', 'https://c.com'],
  groups: [{ title: 'Research', color: 'blue', collapsed: false, urlIndices: [1, 2] }],
  createdAt: '2026-01-01T00:00:00Z'
};
const r2 = normalizeSession(legacy);
check('legacy → v1: single window', r2?.windows?.length === 1);
check('legacy → v1: tab order preserved', r2.windows[0].tabs.map(t => t.url).join(',') === 'https://a.com,https://b.com,https://c.com');
check('legacy → v1: membership [null,g1,g1]', JSON.stringify(r2.windows[0].tabs.map(t => t.groupId)) === '[null,"g1","g1"]');
check('legacy → v1: group meta converted', r2.windows[0].groups[0].title === 'Research' && r2.windows[0].groups[0].color === 'blue');

/* 3. Orphan group + empty window cleanup */
const r3 = normalizeSession({
  name: 'Orphans',
  windows: [
    { state: 'normal', focused: true, tabs: [{ url: 'https://x.com', title: '', pinned: false, active: false, groupId: null }], groups: [{ id: 'g9', title: 'Ghost', color: 'red', collapsed: false }] },
    { state: 'normal', focused: false, tabs: [], groups: [] }
  ]
});
check('orphan group dropped', r3.windows.length === 1 && r3.windows[0].groups.length === 0);
check('empty window dropped', r3.windows.length === 1);

/* 4. Corruption safety */
check('null doc → null', normalizeSession(null) === null);
check('empty object → null', normalizeSession({}) === null);
check('empty urls → null', normalizeSession({ urls: [] }) === null);
check('bad windows type → null', normalizeSession({ windows: 'nope' }) === null);
check('tab without url dropped', normalizeSession({
  name: 't', windows: [{ state: 'normal', focused: true, tabs: [{ url: '', title: 'x', pinned: false, active: false, groupId: null }], groups: [] }]
}) === null);
check('bad color → grey', normalizeSession({
  name: 'c', windows: [{ state: 'normal', focused: true, tabs: [{ url: 'https://a.com', title: '', pinned: false, active: false, groupId: 'g1' }], groups: [{ id: 'g1', title: '', color: 'chartreuse', collapsed: false }] }]
}).windows[0].groups[0].color === 'grey');
check('bad state → normal', normalizeSession({
  name: 's', windows: [{ state: 'floating', focused: true, tabs: [{ url: 'https://a.com', title: '', pinned: false, active: false, groupId: null }], groups: [] }]
}).windows[0].state === 'normal');

/* 5. Group-id uniqueness + membership scoping across windows */
const r4 = normalizeSession({
  name: 'Two windows, same group name',
  windows: [
    { state: 'normal', focused: true, tabs: [{ url: 'https://1.com', title: '', pinned: false, active: false, groupId: 'g1' }], groups: [{ id: 'g1', title: 'Research', color: 'blue', collapsed: false }] },
    { state: 'normal', focused: false, tabs: [{ url: 'https://2.com', title: '', pinned: false, active: false, groupId: 'g1' }], groups: [{ id: 'g1', title: 'Work', color: 'red', collapsed: false }] }
  ]
});
const w1 = r4.windows[0], w2 = r4.windows[1];
check('same group id in 2 windows is scoped (w1→Research)', w1.groups[0].title === 'Research' && w1.tabs[0].groupId === 'g1');
check('same group id in 2 windows is scoped (w2→Work)', w2.groups[0].title === 'Work' && w2.tabs[0].groupId === 'g1');

/* 6. Backend normalizer parity */
const backendSrc = readFileSync(join(root, 'tab-saver-backend/routes/sessions.js'), 'utf8');
check('backend normalizer present', backendSrc.includes('function normalizeToV1'));
check('backend normalizer exported for tests', backendSrc.includes('router.normalizeToV1'));
check('backend accepts windows on POST /', backendSrc.includes('Array.isArray(windows) ? windows : null'));
check('worker keeps v1 parity comment', readFileSync(join(root, 'public/background.js'), 'utf8').includes('MUST stay shape-identical'));

/* 7. capture is importable and safe outside Chrome */
check('capture without Chrome → []', Array.isArray(await captureAllWindowsV1()) && (await captureAllWindowsV1()).length === 0);
check('schema version constant = 1', SCHEMA_VERSION === 1);

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
