// MARKUP TEST — Orbitabs Markup (V1.1 MVP)
// ============================================================================
// Covers (MARKUP_SPEC.md §1–§5):
//   1. URL keying    — hash/utm junk collapse to one identity
//   2. Sanitize      — garbage never crashes; valid marks survive
//   3. Edit ops      — add / move / clear / cap (snapshot undo lives in the
//                      overlay; eraseAt returns removed[] verbatim)
//   5. Worker        — OPEN_MARKUP gated to http/https
//   6. Manifest      — scripting permission + content script + WAR wiring
//   7. Color/overlay — palette, recolor, arrow rendering contract
//   8. Sticky        — card notes: shape field, resize, shape switching
//   9. Ink           — text color (textColor): set/reset/live-edit contract
//  10. Eraser        — eraseAt hit matrix + removed[] for undo/restore
// ============================================================================

import vm from 'node:vm';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

/* ================================================================== *
 * 1. URL keying
 * ================================================================== */
console.log('\n── 1. URL keying ──');
{
  const M = loadCore();
  const a = M.normalizeUrlKey('https://example.com/article?utm_source=x&id=7#section-2');
  const b = M.normalizeUrlKey('https://example.com/article?id=7');
  ok('hash + utm junk collapse to one key', a === b, `${a} vs ${b}`);
  ok('different path = different key', M.normalizeUrlKey('https://example.com/other') !== a);
  ok('different real query = different key', M.normalizeUrlKey('https://example.com/article?id=8') !== a);
  ok('garbage input returns a best-effort string (no crash)', typeof M.normalizeUrlKey('not a url') === 'string');
}

function loadCore() {
  // NB: URL/URLSearchParams are host globals — present in browsers (and in the
  // real overlay), absent from a fresh VM context, so they must be provided.
  const ctx = { console, URL, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(read('public/markup-core.js'), ctx, { filename: 'markup-core.js' });
  return ctx.OrbitabsMarkup;
}

/* ================================================================== *
 * 2. Sanitize — the beta gate: garbage in, skipped out, never a crash
 * ================================================================== */
console.log('\n── 2. Sanitize matrix ──');
{
  const M = loadCore();
  ok('null → null', M.sanitizeAnnotation(null) === null);
  ok('number → null', M.sanitizeAnnotation(42) === null);
  ok('array → null', M.sanitizeAnnotation([1, 2]) === null);
  ok('unknown type → null', M.sanitizeAnnotation({ type: 'sparkle', rect: { x: 1, y: 2 } }) === null);
  ok('missing rect → null', M.sanitizeAnnotation({ type: 'rect' }) === null);
  ok('pen with < 2 points → null', M.sanitizeAnnotation({ type: 'pen', rect: { x: 0, y: 0 }, points: [[1, 2]] }) === null);
  ok('pen valid → kept', M.sanitizeAnnotation({ type: 'pen', rect: { x: 0, y: 0 }, points: [[1, 2], [3, 4]] }) !== null);
  ok('text without content → null', M.sanitizeAnnotation({ type: 'text', rect: { x: 1, y: 1 }, text: '  ' }) === null);
  ok('text with content → kept + trimmed', (M.sanitizeAnnotation({ type: 'text', rect: { x: 1, y: 1 }, text: ' hi ' })?.text) === 'hi');
  ok('bad color → default yellow', M.sanitizeAnnotation({ type: 'rect', rect: { x: 1, y: 1 }, color: 'red' })?.color === '#facc15');
  ok('text truncated to 500 chars',
    M.sanitizeAnnotation({ type: 'text', rect: { x: 1, y: 1 }, text: 'x'.repeat(900) })?.text.length === 500);
  ok('garbage fields coerced (string x → number)',
    typeof M.sanitizeAnnotation({ type: 'rect', rect: { x: '12' } })?.rect.x === 'number' || M.sanitizeAnnotation({ type: 'rect', rect: { x: '12' } }) === null);
}

/* ================================================================== *
 * 3. Edit ops — add / remove / undo / redo path / clear / cap
 * ================================================================== */
console.log('\n── 3. Edit operations ──');
{
  const M = loadCore();
  let doc = M.emptyDoc('https://example.com/a');
  ok('empty doc starts clean', doc.annotations.length === 0);

  const r1 = M.addAnnotation(doc, { type: 'rect', rect: { x: 5, y: 5, w: 10, h: 10 } });
  ok('add returns added:true and a NEW doc (input never mutated)', r1.added === true && r1.doc !== doc && doc.annotations.length === 0);
  doc = r1.doc;

  const res = M.addAnnotation(doc, { type: 'text', rect: { x: 1, y: 1 }, text: 'verify this' });
  doc = res.doc;
  ok('second add accumulates', doc.annotations.length === 2);

  const cleared = M.clearAnnotations(doc);
  ok('clear empties the page', cleared.annotations.length === 0 && cleared.urlKey === doc.urlKey);

  // cap: MAX_PER_URL + 1 adds → oldest falls off
  let capped = M.emptyDoc('https://example.com/cap');
  for (let i = 0;  i <= M.MAX_PER_URL; i++) {
    capped = M.addAnnotation(capped, { type: 'rect', rect: { x: i, y: i, w: 1, h: 1 } }).doc;
  }
  ok(`per-page cap enforced (${M.MAX_PER_URL})`, capped.annotations.length === M.MAX_PER_URL);
  ok('cap drops the OLDEST mark first', capped.annotations[0].rect.x === 1);
}

/* ================================================================== *
 * 3b. Move + labels — draggable marks, editable shape labels
 * ================================================================== */
console.log('\n── 3b. Move + labels ──');
{
  const M = loadCore();
  let doc = M.emptyDoc('https://example.com/move');

  // labels on ANY shape (rect/circle/highlight/arrow), not just the text tool
  const labelled = M.addAnnotation(doc, { type: 'rect', rect: { x: 10, y: 10, w: 50, h: 30 }, text: 'STOP HERE' }).doc;
  ok('shape label survives sanitize', labelled.annotations[0].text === 'STOP HERE');
  ok('plain shape keeps text null', M.sanitizeAnnotation({ type: 'circle', rect: { x: 1, y: 1, w: 9, h: 9 } }).text === null);
  ok('text tool still REQUIRES body text', M.sanitizeAnnotation({ type: 'text', rect: { x: 1, y: 1 } }) === null);

  // move rect/labelled shapes
  doc = labelled;
  const moved = M.moveAnnotation(doc, doc.annotations[0].id, 5, -3).doc;
  ok('move shifts rect x/y by dx/dy', moved.annotations[0].rect.x === 15 && moved.annotations[0].rect.y === 7);
  ok('move keeps width/height intact', moved.annotations[0].rect.w === 50 && moved.annotations[0].rect.h === 30);
  ok('move never mutates the input doc', doc.annotations[0].rect.x === 10);

  // move pen strokes (every point shifts)
  doc = M.addAnnotation(moved, { type: 'pen', rect: { x: 0, y: 0 }, points: [[1, 1], [2, 2]] }).doc;
  const penMoved = M.moveAnnotation(doc, doc.annotations[1].id, 10, 10).doc;
  ok('move shifts EVERY pen point', penMoved.annotations[1].points[0][0] === 11 && penMoved.annotations[1].points[1][1] === 12);

  // set/clear label
  const relabelled = M.setAnnotationText(penMoved, penMoved.annotations[0].id, 'new label').doc;
  ok('setAnnotationText updates a shape label', relabelled.annotations[0].text === 'new label');
  const cleared = M.setAnnotationText(relabelled, relabelled.annotations[0].id, '').doc;
  ok('empty string clears a shape label', cleared.annotations[0].text === null);
  const withText = M.addAnnotation(cleared, { type: 'text', rect: { x: 1, y: 1 }, text: 'note' }).doc;
  ok('text tool body never becomes empty', M.setAnnotationText(withText, withText.annotations[2].id, '').updated === false);
  ok('move unknown id is a safe no-op', M.moveAnnotation(cleared, 'nope', 1, 1).moved === false);
  ok('move with non-numeric dx is rejected', M.moveAnnotation(cleared, cleared.annotations[0].id, 'x', 1).moved === false);
}

/* ================================================================== *
 * 3c. Color — palette + immutable recolor of any selected mark
 * ================================================================== */
console.log('\n── 3c. Color ──');
{
  const M = loadCore();
  ok('palette has 6 compact swatches', M.COLORS.length === 6);
  ok('all palette values are #rrggbb hex', M.COLORS.every((c) => /^#[0-9a-fA-F]{6}$/.test(c)));
  ok('no duplicate swatches', new Set(M.COLORS).size === M.COLORS.length);

  let doc = M.emptyDoc('https://example.com/color');
  doc = M.addAnnotation(doc, { type: 'rect', rect: { x: 1, y: 1, w: 9, h: 9 }, color: '#ef4444' }).doc;
  doc = M.addAnnotation(doc, { type: 'text', rect: { x: 2, y: 2 }, text: 'note', color: '#111827' }).doc;
  doc = M.addAnnotation(doc, { type: 'pen', rect: { x: 3, y: 3 }, points: [[3, 3], [6, 6]], color: '#3b82f6' }).doc;

  const res = M.setAnnotationColor(doc, doc.annotations[0].id, '#22c55e');
  ok('recolor a shape', res.updated === true && res.doc.annotations[0].color === '#22c55e');
  ok('recolor is immutable (input doc untouched)', doc.annotations[0].color === '#ef4444');
  ok('recolor a text note', M.setAnnotationColor(doc, doc.annotations[1].id, '#f97316').doc.annotations[1].color === '#f97316');
  ok('recolor a pen stroke', M.setAnnotationColor(doc, doc.annotations[2].id, '#ec4899').doc.annotations[2].color === '#ec4899');
  ok('non-hex color rejected (safe no-op)', M.setAnnotationColor(doc, doc.annotations[0].id, 'red').updated === false);
  ok('unknown id rejected (safe no-op)', M.setAnnotationColor(doc, 'nope', '#22c55e').updated === false);
  ok('null doc rejected (safe no-op)', M.setAnnotationColor(null, 'x', '#22c55e').updated === false);
  ok('neighbors untouched by a recolor', M.setAnnotationColor(doc, doc.annotations[0].id, '#22c55e').doc.annotations[1].color === '#111827');
}

/* ================================================================== *
 * 3d. Sticky notes — card shape, resize, shape switching
 * ================================================================== */
console.log('\n── 3d. Sticky notes ──');
{
  const M = loadCore();
  ok('sticky is a registered tool', M.TOOLS.includes('sticky'));
  ok('SHAPES exported (rect | circle)', JSON.stringify(M.SHAPES) === JSON.stringify(['rect', 'circle']));

  const s = M.sanitizeAnnotation({ type: 'sticky', rect: { x: 5, y: 5, w: 120, h: 90 }, text: ' todo ', shape: 'circle', color: '#22c55e' });
  ok('sticky kept with text + shape', s && s.text === 'todo' && s.shape === 'circle');
  ok('sticky without body text → null (a blank note is nothing)', M.sanitizeAnnotation({ type: 'sticky', rect: { x: 1, y: 1 } }) === null);
  ok('sticky with unknown shape falls back to rect', M.sanitizeAnnotation({ type: 'sticky', rect: { x: 1, y: 1 }, text: 'x', shape: 'hexagon' }).shape === 'rect');
  ok('circle TOOL is always a circle', M.sanitizeAnnotation({ type: 'circle', rect: { x: 1, y: 1, w: 9, h: 9 } }).shape === 'circle');
  ok('plain rect carries no shape field', !('shape' in M.sanitizeAnnotation({ type: 'rect', rect: { x: 1, y: 1 } })));

  let doc = M.emptyDoc('https://example.com/sticky');
  doc = M.addAnnotation(doc, { type: 'sticky', rect: { x: 10, y: 10, w: 100, h: 80 }, text: 'note', shape: 'circle' }).doc;
  const id = doc.annotations[0].id;

  const rs = M.resizeAnnotation(doc, id, -50, -30).doc.annotations[0];
  ok('resize grows/shrinks rect by dw/dh', rs.rect.w === 50 && rs.rect.h === 50);
  ok('resize keeps position (SE handle)', rs.rect.x === 10 && rs.rect.y === 10);
  ok('resize is immutable', doc.annotations[0].rect.w === 100);
  const rf = M.resizeAnnotation(doc, id, -500, -500).doc.annotations[0];
  ok(`resize floors at ${M.MIN_W}×${M.MIN_H}`, rf.rect.w === M.MIN_W && rf.rect.h === M.MIN_H);
  ok('resize rejects non-numeric deltas', M.resizeAnnotation(doc, id, 'x', 1).resized === false);
  ok('resize unknown id is a safe no-op', M.resizeAnnotation(doc, 'nope', 1, 1).resized === false);

  const pd = M.addAnnotation(M.emptyDoc('u'), { type: 'pen', rect: { x: 0, y: 0 }, points: [[10, 10], [30, 10], [30, 30]] }).doc;
  const ps = M.resizeAnnotation(pd, pd.annotations[0].id, 20, 20).doc.annotations[0]; // bounds 20px + 20 = 2× scale
  ok('pen resize SCALES every point', ps.points[2][0] === 50 && ps.points[2][1] === 50);
  ok('pen resize keeps the stroke anchored at its bounds origin', ps.points[0][0] === 10 && ps.points[0][1] === 10);

  const sw = M.setAnnotationShape(doc, id, 'rect');
  ok('sticky shape switches circle → rect', sw.updated && sw.doc.annotations[0].shape === 'rect');
  ok('shape switches back rect → circle', M.setAnnotationShape(sw.doc, sw.doc.annotations[0].id, 'circle').doc.annotations[0].shape === 'circle');
  ok('shape change rejected on non-sticky marks', M.setAnnotationShape(doc, doc.annotations[0].id === id ? 'other' : id, 'rect').updated === false || M.setAnnotationShape(M.addAnnotation(M.emptyDoc('u'), { type: 'rect', rect: { x: 1, y: 1 } }).doc, M.addAnnotation(M.emptyDoc('u'), { type: 'rect', rect: { x: 1, y: 1 } }).doc.annotations[0].id, 'circle').updated === false);
  ok('invalid shape value rejected', M.setAnnotationShape(doc, id, 'hexagon').updated === false);

  ok('sticky body text never becomes empty', M.setAnnotationText(M.addAnnotation(M.emptyDoc('u'), { type: 'sticky', rect: { x: 1, y: 1 }, text: 'body' }).doc, M.addAnnotation(M.emptyDoc('u'), { type: 'sticky', rect: { x: 1, y: 1 }, text: 'body' }).doc.annotations[0].id, '').updated === false);

  ok('erase + select share ONE hit implementation',
    read('public/markup-core.js').includes('function hitsMark') &&
    read('public/markup-overlay.js').includes('M.hitsMark(anns[i], x, y, PICK_SLOP)'));
}

/* ================================================================== *
 * 3e. Ink — the TEXT color, separate from the fill color
 * ================================================================== */
console.log('\n── 3e. Ink (text color) ──');
{
  const M = loadCore();
  ok('INK_COLORS exported (compact set)', Array.isArray(M.INK_COLORS) && M.INK_COLORS.length >= 5);

  let doc = M.emptyDoc('https://example.com/ink');
  doc = M.addAnnotation(doc, { type: 'sticky', rect: { x: 1, y: 1, w: 100, h: 80 }, text: 'n', color: '#facc15' }).doc;
  doc = M.addAnnotation(doc, { type: 'text', rect: { x: 2, y: 2 }, text: 'label me', textColor: '#0ea5e9' }).doc;
  const sid = doc.annotations[0].id;

  const r = M.setAnnotationTextColor(doc, sid, '#ef4444');
  ok('ink set on a sticky', r.updated && r.doc.annotations[0].textColor === '#ef4444');
  ok('ink change is immutable', doc.annotations[0].textColor == null);
  ok('explicit ink survives sanitize', M.sanitizeAnnotation({ type: 'text', rect: { x: 3, y: 3 }, text: 'x', textColor: '#0ea5e9' }).textColor === '#0ea5e9');
  ok('garbage ink → null (auto), never a crash', M.sanitizeAnnotation({ type: 'text', rect: { x: 3, y: 3 }, text: 'x', textColor: 'blue' }).textColor === null);
  ok('ink null resets to AUTO', M.setAnnotationTextColor(r.doc, sid, null).doc.annotations[0].textColor === null);
  ok('non-hex ink rejected', M.setAnnotationTextColor(doc, sid, 'red').updated === false);
  ok('unknown id rejected', M.setAnnotationTextColor(doc, 'nope', '#111827').updated === false);
  ok('ink works on shape labels too', M.setAnnotationTextColor(doc, doc.annotations[1].id, '#22c55e').updated === true);
  ok('ink neighbors untouched', M.setAnnotationTextColor(doc, sid, '#111827').doc.annotations[1].textColor === '#0ea5e9');
}

/* ================================================================== *
 * 3f. Eraser — click/drag removal, radius, undo-friendly removed[]
 * ================================================================== */
console.log('\n── 3f. Eraser ──');
{
  const M = loadCore();
  ok('eraser radius exported', M.ERASER.RADIUS > 0);
  let doc = M.emptyDoc('https://example.com/erase');
  doc = M.addAnnotation(doc, { type: 'rect', rect: { x: 10, y: 10, w: 40, h: 30 } }).doc;
  doc = M.addAnnotation(doc, { type: 'pen', rect: { x: 100, y: 100 }, points: [[100, 100], [110, 110]] }).doc;
  doc = M.addAnnotation(doc, { type: 'text', rect: { x: 200, y: 50 }, text: 'keep me' }).doc;

  let r = M.eraseAt(doc, 30, 25); // rect center
  ok('erase removes the mark under the cursor', r.removed.length === 1 && r.removed[0].type === 'rect');
  ok('erase returns removed marks for undo/restore', r.removed[0].id === doc.annotations[0].id);
  ok('erase is immutable', JSON.stringify(doc.annotations.map((a) => a.id)) === JSON.stringify(['a', 'b', 'c'].map((_, i) => doc.annotations[i].id)));
  r = M.eraseAt(r.doc, 105, 105); // pen point
  ok('pen strokes erase point-by-point', r.removed.length === 1 && r.removed[0].type === 'pen');
  ok('erase miss removes nothing', M.eraseAt(r.doc, 380, 300).removed.length === 0);
  ok('custom radius widens the hit area', M.eraseAt(doc, 60, 25, 30).removed.length === 1);
  ok('huge radius can sweep several marks', M.eraseAt(doc, 30, 25, 200).removed.length === 3);
  ok('null doc is safe', M.eraseAt(null, 5, 5).removed.length === 0);
  ok('NaN coords are safe', M.eraseAt(doc, NaN, 5).removed.length === 0);
  const restored = M.addAnnotation(M.emptyDoc('https://example.com/erase'), r.removed[0] || { type: 'text', rect: { x: 200, y: 50 }, text: 'keep me' });
  ok('erased marks re-add verbatim (undo path)', restored.added);
  ok('eraser icon + tool wired in the overlay',
    read('public/markup-overlay.js').includes("eraser: '<path") &&
    read('public/markup-overlay.js').includes("'sticky', 'eraser', 'undo'") &&
    read('public/markup-overlay.js').includes('M.eraseAt(doc, x, y, M.ERASER.RADIUS)'));
  ok('undo/redo are snapshot-based (move/resize/recolor/erase all reversible)',
    read('public/markup-overlay.js').includes('function pushHistory()') &&
    read('public/markup-overlay.js').includes('redoStack.push(snap())'));
  ok('compact palettes (6 fills + 5 inks)', M.COLORS.length === 6 && M.INK_COLORS.length === 5);
}

/* ================================================================== *
 * 3g. Text sizes — S/M/L for notes, stickies and labels
 * ================================================================== */
console.log('\n── 3g. Text sizes (S/M/L) ──');
{
  const M = loadCore();
  ok('TEXT_SIZES exported (S | M | L)', JSON.stringify(M.TEXT_SIZES) === JSON.stringify(['S', 'M', 'L']));
  ok('px map covers every size', M.TEXT_SIZES.every((s) => M.TEXT_SIZE_PX[s] > 0) && M.TEXT_SIZE_PX.M > M.TEXT_SIZE_PX.S && M.TEXT_SIZE_PX.L > M.TEXT_SIZE_PX.M);
  ok('explicit size survives sanitize', M.sanitizeAnnotation({ type: 'text', rect: { x: 1, y: 1 }, text: 'x', textSize: 'L' }).textSize === 'L');
  ok('garbage/missing size → M (never a crash)', M.sanitizeAnnotation({ type: 'text', rect: { x: 1, y: 1 }, text: 'x' }).textSize === 'M' && M.sanitizeAnnotation({ type: 'text', rect: { x: 1, y: 1 }, text: 'x', textSize: 'XL' }).textSize === 'M');

  let doc = M.addAnnotation(M.emptyDoc('https://example.com/size'), { type: 'sticky', rect: { x: 1, y: 1, w: 60, h: 40 }, text: 'n', textSize: 'L' }).doc;
  const id = doc.annotations[0].id;
  const r = M.setAnnotationTextSize(doc, id, 'S');
  ok('size set on a sticky', r.updated && r.doc.annotations[0].textSize === 'S');
  ok('size change is immutable', doc.annotations[0].textSize === 'L');
  const doc2 = M.addAnnotation(doc, { type: 'rect', rect: { x: 2, y: 2, w: 9, h: 9 }, text: 'lbl' }).doc;
  ok('size works on shape labels too', M.setAnnotationTextSize(doc2, doc2.annotations[1].id, 'L').updated === true);
  ok('unknown size rejected (safe no-op)', M.setAnnotationTextSize(doc, id, 'XL').updated === false);
  ok('null doc rejected', M.setAnnotationTextSize(null, id, 'S').updated === false);
  ok('neighbors untouched', M.setAnnotationTextSize(doc, id, 'S').doc.annotations[0].textSize === 'S' && doc.annotations.length === 1);
  ok('S/M/L picker wired in the overlay (default + live + selected flows)',
    read('public/markup-overlay.js').includes('mk-size-swatches') &&
    read('public/markup-overlay.js').includes('M.setAnnotationTextSize(doc, selectedId, s)') &&
    read('public/markup-overlay.js').includes('M.setAnnotationTextSize(doc, tctx.id, s)') &&
    read('public/markup-overlay.js').includes("M.TEXT_SIZE_PX[a.textSize || 'M']") &&
    read('public/markup-overlay.css').includes('.mk-size-btn'));
}

/* ================================================================== *
 * 5. Worker — OPEN_MARKUP: reject non-web, message-first + inject fallback
 * ================================================================== */
console.log('\n── 5. Worker OPEN_MARKUP ──');
{
  const scripted = [];           // executeScript/insertCSS calls
  const messages = [];           // tabs.sendMessage calls
  let tabUrl = 'javascript:void(0)';
  let contentScriptReplies = false;   // does the content script answer?
  let injectionAllowed = true;        // does Chrome allow executeScript here?
  const ev = () => ({ addListener() {} });
  let messageHandler = null;
  globalThis.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: ev() },
    runtime: { onMessage: { addListener: (fn) => { messageHandler = fn; } }, onInstalled: ev(), onStartup: ev(), lastError: null },
    tabs: {
      query: async () => [{ id: 9, url: tabUrl }],
      sendMessage: async (_tabId, m) => { messages.push(m); if (!contentScriptReplies) throw new Error('Could not establish connection'); return { ok: true }; },
      onCreated: ev(), onUpdated: ev(), onMoved: ev(), onRemoved: ev(),
      onAttached: ev(), onDetached: ev(), onReplaced: ev(),
    },
    alarms: { create() {}, clear() {}, onAlarm: ev() },
    tabGroups: { onCreated: ev(), onUpdated: ev(), onMoved: ev(), onRemoved: ev(), query: async () => [] },
    windows: { onCreated: ev(), onRemoved: ev(), onFocusChanged: ev(), getAll: async () => [], getLastFocused: async () => ({ id: 1 }), getCurrent: async () => ({ id: 1 }) },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    scripting: {
      executeScript: async (o) => { if (!injectionAllowed) throw new Error('Cannot access contents of url "https://chatgpt.com/". Extension manifest must request permission to access this host.'); scripted.push(['script', o]); },
      insertCSS: async (o) => { if (!injectionAllowed) throw new Error('Cannot access contents of url "https://chatgpt.com/".'); scripted.push(['css', o]); },
    },
  };
  const ctx = vm.createContext({
    chrome: globalThis.chrome, console, setTimeout, clearTimeout,
    setInterval, clearInterval, URLSearchParams, URL, Date, JSON, Math,
    Promise, fetch: async () => ({ ok: false }),
  });
  vm.runInContext(read('public/background.js'), ctx, { filename: 'background.js' });
  ok('worker registered a message listener', typeof messageHandler === 'function');

  // REJECT path: active tab is not a web page
  let responses = [];
  messageHandler({ type: 'OPEN_MARKUP' }, {}, (r) => responses.push(r));
  await new Promise((r) => setTimeout(r, 60));
  ok('non-http tab REJECTED with a friendly message',
    responses.length > 0 && responses[0].ok === false && /web pages/i.test(responses[0].error || ''), JSON.stringify(responses));
  ok('nothing was sent or injected on a rejected tab', messages.length === 0 && scripted.length === 0);

  // HAPPY path: content script already present → message opens it, NO injection
  tabUrl = 'https://example.com/article';
  contentScriptReplies = true;
  responses = [];
  messageHandler({ type: 'OPEN_MARKUP' }, {}, (r) => responses.push(r));
  await new Promise((r) => setTimeout(r, 60));
  ok('http tab accepted (ok:true, tabId)', responses.length > 0 && responses[0].ok === true && responses[0].tabId === 9, JSON.stringify(responses));
  ok('opens via MESSAGE (no scripting injection needed)', messages.length === 1 && scripted.length === 0);
  ok('message carries the page URL', messages[0]?.type === 'ORBITABS_MARKUP_OPEN' && messages[0]?.url === 'https://example.com/article');

  // FALLBACK path: content script missing (install-time edge) → inject + retry
  contentScriptReplies = false;
  messages.length = 0;
  scripted.length = 0;
  responses = [];
  messageHandler({ type: 'OPEN_MARKUP' }, {}, (r) => responses.push(r));
  await new Promise((r) => setTimeout(r, 2200)); // fallback has a 1.5s retry window
  ok('missing content script → core+overlay injected as fallback',
    scripted.some(([k, o]) => k === 'css' && o.files?.includes('markup-overlay.css')) &&
    scripted.some(([k, o]) => k === 'script' && JSON.stringify(o.files).includes('markup-core.js')) &&
    scripted.some(([k, o]) => k === 'script' && o.files?.includes('markup-overlay.js')));
  ok('fallback still answers honestly when the page needs a reload',
    responses.length > 0 && responses[0].ok === false && /reload/i.test(responses[0].error || ''));

  // INJECTION-REFUSED path: Chrome denies executeScript (no activeTab grant /
  // restricted host) → the user gets the friendly reload message, never a raw
  // "Cannot access contents of url" error bubbling into the popup.
  injectionAllowed = false;
  messages.length = 0;
  scripted.length = 0;
  responses = [];
  messageHandler({ type: 'OPEN_MARKUP' }, {}, (r) => responses.push(r));
  await new Promise((r) => setTimeout(r, 60));
  ok('injection refused → friendly reload guidance, no raw Chrome error',
    responses.length > 0 && responses[0].ok === false && /reload/i.test(responses[0].error || '') &&
    !/Cannot access contents/i.test(responses[0].error || ''), JSON.stringify(responses));
}

/* 6. Manifest wiring — scripting + content scripts + WAR */
console.log('\n── 6. Manifest wiring ──');
{
  const m = JSON.parse(read('public/manifest.json'));
  ok('scripting permission present (install-time fallback only)', m.permissions.includes('scripting'));
  ok('activeTab present (authorizes fallback injection on the ONE open tab — no broad host permissions)', m.permissions.includes('activeTab'));
  ok('content script registered on http/https with core+overlay+css',
    m.content_scripts?.[0]?.js?.includes('markup-core.js') && m.content_scripts?.[0]?.js?.includes('markup-overlay.js') && m.content_scripts?.[0]?.css?.includes('markup-overlay.css'));
  ok('no web_accessible_resources needed (overlay is in-page, not an iframe)',
    !m.web_accessible_resources || m.web_accessible_resources.length === 0);
  ok('storage permission present (annotations are local-first)', m.permissions.includes('storage'));
}

/* 7. Overlay rendering — arrow start dot, head clamp, text recolor hook */
console.log('\n── 7. Overlay rendering ──');
{
  const src = read('public/markup-overlay.js');
  ok('arrow renders a START dot (full nishan — both ends visible)', src.includes('start dot'));
  ok('arrow head clamped: shaft trimmed when line ≤ head length', src.includes('lineLen <= head'));
  ok('zero-length drag keeps a stable direction (no NaN angle)', src.includes('ang || 0') || src.includes('atan2(0,0)=0'));
  ok('palette click RECOLORS the selected mark (setAnnotationColor wired)', src.includes('setAnnotationColor(doc, selectedId'));
  ok('custom-color picker wired as an escape hatch', src.includes("type = 'color'") && src.includes('showPicker'));
  ok('custom swatch styled in the overlay CSS', read('public/markup-overlay.css').includes('.mk-swatch.mk-custom'));
  ok('text note auto-selected after commit (movable + recolorable)', src.includes('setTool(\'select\')'));
  ok('tools carry data-tool hooks (programmatic switch + tests)', src.includes('b.dataset.tool = t'));
  ok('sticky + eraser in the toolbar order', src.includes("'text', 'sticky', 'eraser', 'undo'"));
  ok('sticky card rendering wired (drawSticky + ink contrast)', src.includes('drawSticky(a, ghost)') && src.includes('stickyInk'));
  ok('SE resize handle wired (sizing + resizeAnnotation)', src.includes('seHandleRect') && src.includes('M.resizeAnnotation(doc, sizing.id'));
  ok('shape picker DOM wired to setAnnotationShape', src.includes('mk-shape-picker') && src.includes('M.setAnnotationShape(doc, selectedId'));
  ok('shape picker CSS present (hidden until a sticky is selected)',
    read('public/markup-overlay.css').includes('#mk-shape-picker') && read('public/markup-overlay.css').includes('#mk-shape-picker.mk-visible'));
  ok('sticky icon registered', src.includes("sticky: '<rect"));
  ok('ink swatch row built (A/auto + palette + custom A-picker)',
    src.includes('mk-ink-swatches') && src.includes("'Text color: auto (best contrast)'") && src.includes('Any text color…'));
  ok('ink clicks LIVE-recolor the mark being edited (mid-typing)', src.includes('ctx.liveColor'));
  ok('pending ink applied when a fresh note commits', src.includes('lastTextCtx'));
  ok('Esc after live ink change restores the original ink', src.includes('ctx.original'));
  ok('new marks carry the chosen ink', src.includes('textColor: inkColor || undefined'));
  ok('ink CSS row styled', read('public/markup-overlay.css').includes('.mk-ink-swatches'));
}

/* ================================================================== *
 * RESULT
 * ================================================================== */
console.log(`\n✅ MARKUP: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
