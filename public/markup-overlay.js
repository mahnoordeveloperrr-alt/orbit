// 🖊 ORBITABS MARKUP — IN-PAGE OVERLAY (content script, isolated world)
// ---------------------------------------------------------------------------
// This content script IS the overlay app. It runs on every http/https page
// (manifest content_scripts) in an isolated world, so opening Markup needs no
// extra injection permissions — the popup's pen button just sends a message.
// Everything Orbitabs adds lives on OUR elements (mk- prefixed, position:fixed,
// topmost z-index) and is fully removed on exit. The website's own DOM/content
// is never modified. Annotations are DATA (markup-core.js) saved to
// chrome.storage.local under `orbi_annotations`, keyed by page URL.
//
// Tools: cursor (select/move/resize), pen, highlight, rect, circle, arrow,
// text, sticky, eraser. Sticky notes are labeled cards (rect or circle —
// switch via the shape picker) that you draw to size, type into, resize by
// the SE handle, drag, and recolor. Shapes accept an optional label (typed
// right after drawing, or double-click to edit later); marks can be dragged
// with the cursor tool; a selected mark is recolored by a palette click and
// re-labeled by double-click. Undo/redo work on full-document snapshots, so
// EVERY operation — draw, erase, move, resize, recolor — is reversible.
(function () {
  'use strict';
  if (globalThis.__orbitabsMarkupActive) return; // overlay already open
  const M = globalThis.OrbitabsMarkup;           // markup-core.js loads first
  if (!M) return;

  let root = null;      // everything we add lives in here
  let canvas = null;
  let ctx = null;
  let url = '';
  let doc = M.emptyDoc('');
  let anns = [];
  let undoStack = [];   // history: [beforeSnapshots] for undo
  let redoStack = [];   // history: [afterSnapshots] for redo
  let tool = 'pen';
  let color = M.COLORS[0];
  let drawing = null;   // in-flight mark
  let drag = null;      // { id, dx, dy } while moving an existing mark
  let selectedId = null; // mark being manipulated — palette clicks recolor it
  let sizing = null;    // { id, last:{x,y} } SE-handle resize of a selected sticky
  let erasing = false;  // eraser stroke in progress
  let inkColor = null;      // default TEXT ink for new marks (null = auto)
  let textSize = 'M';       // default TEXT size for new marks (S | M | L)
  let activeTextCtx = null; // { id, pending, pendingSize, liveColor, liveSize, original, originalSize } while a text input is open
  let lastTextCtx = null;   // the ctx of the text input that JUST closed (pending ink + size)

  /* ---------------- history (snapshot-based) ----------------
     pushHistory() captures the CURRENT doc before a mutation. Undo restores
     the last snapshot and parks the discarded state for redo; redo replays
     forward. Every mutating flow calls it exactly once per user action. */
  function snap() {
    return { url: doc.url, urlKey: doc.urlKey, annotations: anns.map((a) => ({ ...a, rect: { ...a.rect }, points: a.points ? a.points.map((p) => [...p]) : undefined })) };
  }

  function pushHistory() {
    undoStack.push(snap());
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
  }

  /* ---------------- typography (simple & beautiful) ----------------
     NO webfont here: Inter isn't loaded on web pages, so asking for it just
     yields a synthesized-bold fallback. The system UI stack IS the beautiful,
     zero-load answer — Segoe UI on Windows, SF on macOS, Roboto on ChromeOS —
     at weight 500 (medium): lighter and cleaner than bold. */
  const MARKUP_FONT = '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';

  /* ---------------- SVG icon set (crisp at any DPI, no emoji) ---------------- */
  const ICON_PATHS = {
    select: '<path d="m4 4 7.07 17 2.51-7.39L21 11.07z"/>',
    pen: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    rect: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    arrow: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    text: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
    sticky: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M20 12h-6v8"/>',
    eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
    clear: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
    exit: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };
  const TOOL_ORDER = ['select', 'pen', 'highlight', 'rect', 'circle', 'arrow', 'text', 'sticky', 'eraser', 'undo', 'redo', 'clear', 'save', 'exit'];
  const NAMES = {
    select: 'Select / Move / Resize — drag marks; SE corner resizes stickies; double-click to label',
    pen: 'Pen', highlight: 'Highlight', rect: 'Rectangle', circle: 'Circle',
    arrow: 'Arrow', text: 'Text note', sticky: 'Sticky note — draw a card, type inside, resize from the corner',
    eraser: 'Eraser — click or drag across marks to remove them',
    undo: 'Undo', redo: 'Redo',
    clear: 'Clear this page', save: 'Save annotations', exit: 'Close Markup'
  };

  function svgIcon(name) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = ICON_PATHS[name];
    return s;
  }

  /* ---------------- build the overlay ---------------- */
  // Hidden <input type=color> opener shared by both custom pickers. The input
  // must be position:absolute INSIDE #root — a fixed element at (0,0) can fall
  // outside the page's painted attachment on some pages and Chrome clips it.
  function wireColorInput(inp, commit) {
    inp.style.position = 'absolute';
    inp.style.top = '0';
    inp.style.left = '0';
    inp.style.opacity = '0';
    inp.style.pointerEvents = 'none';
    inp.addEventListener('change', commit);
    inp.addEventListener('blur', () => { commit(); inp.remove(); });
    root.appendChild(inp);
  }

  function build() {
    if (root) return true;
    root = document.createElement('div');
    root.id = 'orbitabs-markup-root';
    canvas = document.createElement('canvas');
    canvas.id = 'mk-canvas';
    ctx = canvas.getContext('2d');
    root.appendChild(canvas);

    const bar = document.createElement('div');
    bar.id = 'mk-toolbar';
    const swatches = document.createElement('div');
    swatches.className = 'mk-swatches';
    M.COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'mk-swatch' + (i === 0 ? ' mk-active' : '');
      b.style.background = c;
      b.title = 'Color';
      b.addEventListener('click', () => selectSwatch(c, b));
      swatches.appendChild(b);
    });
    // 🎨 full-palette escape hatch — any color the swatches don't cover
    const custom = document.createElement('button');
    custom.className = 'mk-swatch mk-custom';
    custom.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.68-.75 1.68-1.68 0-.44-.18-.84-.46-1.13-.29-.29-.46-.68-.46-1.13 0-.93.75-1.68 1.68-1.68h1.98c3.1 0 5.58-2.6 5.58-5.68C22 5.5 17.5 2 12 2z"/></svg>';
    custom.title = 'Any color…';
    custom.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = color;
    wireColorInput(inp, () => selectSwatch(inp.value, custom));
    try { inp.showPicker(); } catch (_) { inp.click(); } // Chrome gate: user gesture
  });
  swatches.appendChild(custom);
    bar.appendChild(swatches);

    // Ink (TEXT color) row — separate from fill: notes and labels can be
    // recolored AFTER typing and even WHILE typing (live preview on edits).
    const inkRow = document.createElement('div');
    inkRow.className = 'mk-swatches mk-ink-swatches';
    const mkInkBtn = (c, label) => {
      const b = document.createElement('button');
      b.className = 'mk-swatch';
      if (c) b.style.background = c;
      b.title = label;
      b.addEventListener('click', () => selectInkSwatch(c, b));
      inkRow.appendChild(b);
      return b;
    };
    const autoInk = mkInkBtn(null, 'Text color: auto (best contrast)');
    autoInk.textContent = 'A';
    autoInk.classList.add('mk-ink-auto');
    if (!inkColor) autoInk.classList.add('mk-active');
    M.INK_COLORS.forEach((c) => {
      const b = mkInkBtn(c, 'Text color');
      if (c === inkColor) b.classList.add('mk-active');
    });
    const inkCustom = document.createElement('button');
    inkCustom.className = 'mk-swatch mk-custom mk-ink-custom';
    inkCustom.title = 'Any text color…';
    inkCustom.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 12 4l8 16"/><path d="M7.5 14h9"/></svg>';
    inkCustom.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = inkColor || '#111827';
      wireColorInput(inp, () => selectInkSwatch(inp.value, inkCustom));
      try { inp.showPicker(); } catch (_) { inp.click(); }
    });
    inkRow.appendChild(inkCustom);
    bar.appendChild(inkRow);

    // Text-size picker — S/M/L for notes, stickies and labels. Same three
    // contexts as ink: default for NEW marks, live on the note being typed,
    // instant on the selected mark.
    const sizeRow = document.createElement('div');
    sizeRow.className = 'mk-swatches mk-size-swatches';
    M.TEXT_SIZES.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'mk-size-btn' + (s === textSize ? ' mk-active' : '');
      b.textContent = s;
      b.dataset.size = s;
      b.title = 'Text size: ' + s;
      b.addEventListener('click', () => selectTextSize(s, b));
      sizeRow.appendChild(b);
    });
    bar.appendChild(sizeRow);

    TOOL_ORDER.forEach((t) => {
      if (t === 'save') {
        const s = document.createElement('span');
        s.className = 'mk-status';
        bar.appendChild(s);
      }
      const b = document.createElement('button');
      b.appendChild(svgIcon(t));
      b.title = NAMES[t];
      b.dataset.tool = t;
      if (t === 'clear') b.classList.add('mk-danger');
      if (t === tool) b.classList.add('mk-active');
      b.addEventListener('click', () => onTool(t, b, bar));
      bar.appendChild(b);
    });
    root.appendChild(bar);

    // Sticky shape picker — appears when a sticky note is selected; switches
    // the card between rectangle and circle (rendered in-page on the canvas)
    const shapes = document.createElement('div');
    shapes.id = 'mk-shape-picker';
    shapes.innerHTML =
      '<span>Shape</span>' +
      '<button data-shape="rect" title="Rectangle card"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/></svg></button>' +
      '<button data-shape="circle" title="Circle card"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg></button>';
    shapes.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        if (!selectedId) return;
        const { doc: updated, updated: ok } = M.setAnnotationShape(doc, selectedId, b.dataset.shape);
        if (ok) { doc = updated; anns = doc.annotations; saveDoc(); }
        syncShapePicker();
        render();
      });
    });
    root.appendChild(shapes);

    const hint = document.createElement('div');
    hint.id = 'mk-hint';
    hint.textContent = 'Draw with a tool — cursor tool moves marks (double-click to label; click a mark, then a color, to recolor). Nothing on the website itself is changed.';
    root.appendChild(hint);

    document.documentElement.appendChild(root);
    globalThis.__orbitabsMarkupActive = true;
    globalThis.__orbitabsMarkupSyncPicker = syncShapePicker; // harness hook
    undoStack = []; redoStack = [];

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDblClick);
    window.addEventListener('resize', resize);
    resize();
    return true;
  }

  // One place for color selection: sets the drawing color, marks the active
  // swatch, and — when a mark is selected — RECOLORS it live (request 3).
  function selectSwatch(c, btn) {
    color = c;
    root.querySelectorAll('.mk-swatches:not(.mk-ink-swatches) .mk-swatch').forEach((s) => s.classList.remove('mk-active'));
    btn.classList.add('mk-active');
    if (selectedId) {
      pushHistory(); // recolor is one reversible action
      const { doc: recolored } = M.setAnnotationColor(doc, selectedId, c);
      doc = recolored; anns = doc.annotations;
      saveDoc();
    }
    render();
  }

  // Text-color selection: sets the ink for FUTURE marks, live-recolors the
  // mark being edited (even mid-typing), or recolors the selected mark.
  function markInkActive(btn) {
    root.querySelectorAll('.mk-ink-swatches .mk-swatch').forEach((s) => s.classList.remove('mk-active'));
    if (btn) btn.classList.add('mk-active');
  }

  function selectInkSwatch(c, btn) {
    inkColor = c || null;
    markInkActive(btn);
    const ctx = activeTextCtx;
    if (ctx) {
      if (ctx.id) {
        // editing an existing mark — LIVE preview while the textarea is open
        if (ctx.liveColor === undefined) pushHistory(); // first live ink change this edit
        ctx.liveColor = c || null;
        const { doc: upd } = M.setAnnotationTextColor(doc, ctx.id, ctx.liveColor);
        doc = upd; anns = doc.annotations;
        render();
      } else {
        ctx.pending = c || null; // first typing — applied when the note commits
      }
      return;
    }
    if (selectedId) {
      // not typing: recolor the selected mark's text right away
      pushHistory();
      const { doc: upd } = M.setAnnotationTextColor(doc, selectedId, inkColor);
      doc = upd; anns = doc.annotations;
      saveDoc();
    }
    render();
  }

  // Text-SIZE selection: sets the size for FUTURE marks, live-resizes the
  // mark being edited (even mid-typing), or resizes the selected mark's text.
  function selectTextSize(s, btn) {
    textSize = s;
    root.querySelectorAll('.mk-size-swatches .mk-size-btn').forEach((b) => b.classList.remove('mk-active'));
    if (btn) btn.classList.add('mk-active');
    const tctx = activeTextCtx;
    if (tctx) {
      if (tctx.id) {
        // editing an existing mark — LIVE preview while the textarea is open
        if (tctx.liveSize === undefined) pushHistory(); // first size change this edit
        tctx.liveSize = s;
        const { doc: upd } = M.setAnnotationTextSize(doc, tctx.id, s);
        doc = upd; anns = doc.annotations;
        render();
      } else {
        tctx.pendingSize = s; // first typing — applied when the note commits
      }
      return;
    }
    if (selectedId) {
      // not typing: resize the selected mark's text right away
      pushHistory();
      const { doc: upd } = M.setAnnotationTextSize(doc, selectedId, s);
      doc = upd; anns = doc.annotations;
      saveDoc();
    }
    render();
  }

  // Show the shape picker only while a sticky note is selected
  function syncShapePicker() {
    const p = root && root.querySelector('#mk-shape-picker');
    if (!p) return;
    const sel = anns.find((a) => a.id === selectedId);
    p.classList.toggle('mk-visible', !!(sel && sel.type === 'sticky'));
    p.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('mk-active', !!sel && (sel.shape || 'rect') === b.dataset.shape));
  }

  function onTool(t, btn, bar) {
    if (t === 'select' || t === 'eraser' || M.TOOLS.includes(t)) {
      tool = t;
      if (t !== 'select') selectedId = null; // drawing tools drop the selection
      canvas.style.cursor = t === 'eraser' ? 'cell' : t === 'select' ? 'default' : 'crosshair';
      bar.querySelectorAll('button').forEach((b) => b.classList.remove('mk-active'));
      btn.classList.add('mk-active');
      syncShapePicker();
      render();
      return;
    }
    if (t === 'undo') {
      const prev = undoStack.pop();
      if (prev) {
        redoStack.push(snap());
        doc = prev; anns = doc.annotations;
        if (!anns.some((a) => a.id === selectedId)) selectedId = null;
        saveDoc(); syncShapePicker(); render();
      }
      return;
    }
    if (t === 'redo') {
      const next = redoStack.pop();
      if (next) {
        undoStack.push(snap());
        doc = next; anns = doc.annotations;
        if (!anns.some((a) => a.id === selectedId)) selectedId = null;
        saveDoc(); syncShapePicker(); render();
      }
      return;
    }
    if (t === 'clear') {
      if (anns.length && window.confirm('Clear all markup on this page? This cannot be undone.')) {
        pushHistory();
        selectedId = null;
        doc = M.clearAnnotations(doc);
        anns = doc.annotations;
        saveDoc(); syncShapePicker(); render();
      }
      return;
    }
    if (t === 'save') {
      saveDoc().then(() => flash('Saved ✓')).catch(() => flash('Save failed'));
      return;
    }
    if (t === 'exit') teardown();
  }

  /* ---------------- canvas sizing + rendering ---------------- */
  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    render();
  }

  function penBounds(a) {
    const xs = a.points.map((p) => p[0]);
    const ys = a.points.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  function drawMark(a, ghost) {
    ctx.save();
    ctx.globalAlpha = ghost ? 0.55 : (a.type === 'highlight' ? 0.35 : 1);
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = a.type === 'highlight' ? 18 : 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (a.type === 'pen' && a.points && a.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(a.points[0][0], a.points[0][1]);
      a.points.forEach((p) => ctx.lineTo(p[0], p[1]));
      ctx.stroke();
    } else if (a.type === 'highlight') {
      ctx.fillRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h);
    } else if (a.type === 'rect') {
      ctx.strokeRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h);
    } else if (a.type === 'circle') {
      const cx = a.rect.x + a.rect.w / 2, cy = a.rect.y + a.rect.h / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(a.rect.w / 2) || 1, Math.abs(a.rect.h / 2) || 1, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (a.type === 'arrow') {
      const x1 = a.rect.x, y1 = a.rect.y;
      const x2 = a.rect.x + a.rect.w, y2 = a.rect.y + a.rect.h;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = 12;
      const lineLen = Math.hypot(x2 - x1, y2 - y1);
      // head shorter than the line? trim the shaft so it never pokes out;
      // zero-length drag? atan2(0,0)=0 → stable default direction (→ east)
      const shaftEnd = lineLen <= head
        ? { x: x1 + Math.cos(ang) * lineLen, y: y1 + Math.sin(ang) * lineLen }
        : { x: x2, y: y2 };
      // start dot — shows WHERE the arrow begins (request 4)
      ctx.beginPath();
      ctx.arc(x1, y1, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(shaftEnd.x, shaftEnd.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
      ctx.closePath(); ctx.fill();
    }

    // STICKY NOTE — card (rect | circle) with readable body text inside:
    // dark ink on light fills, light ink on dark, folded corner, wrapped
    if (a.type === 'sticky' && a.text) drawSticky(a, ghost);

    // Label / text body — inside shapes, beside arrows, at the point for text
    if (a.text && a.type !== 'sticky') {
      let tx = a.rect.x, ty = a.rect.y;
      if (a.type === 'text') { ty += 4; }
      else if (a.type === 'arrow') { tx = a.rect.x + a.rect.w + 6; ty = a.rect.y + a.rect.h + 6; }
      else if (a.type === 'highlight') { ty = a.rect.y + a.rect.h + 16; }
      else { tx += 6; ty += Math.max(14, a.rect.h / 2 + 5); }
      ctx.globalAlpha = ghost ? 0.55 : 1;
      ctx.font = '500 ' + M.TEXT_SIZE_PX[a.textSize || 'M'] + 'px ' + MARKUP_FONT;
      ctx.fillStyle = a.textColor || a.color;
      // soft readability glow — just enough to lift text off busy photos,
      // not the hazy halo a heavier shadow produced
      ctx.shadowColor = 'rgba(255,255,255,0.75)';
      ctx.shadowBlur = 3;
      wrapText(a.text, tx, ty, 260, 19);
    }
    ctx.restore();
  }

  /* ---------------- sticky note rendering ---------------- */
  function stickyInk(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 150 ? '#111827' : '#f8fafc';
  }

  function drawSticky(a, ghost) {
    const r = a.rect;
    const x = Math.min(r.x, r.x + r.w), y = Math.min(r.y, r.y + r.h);
    const w = Math.max(Math.abs(r.w), M.MIN_W), h = Math.max(Math.abs(r.h), M.MIN_H);
    ctx.save();
    ctx.globalAlpha = ghost ? 0.55 : (a.type === 'highlight' ? 0.35 : 1);
    ctx.fillStyle = a.color;
    if (a.shape === 'circle') {
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const fold = Math.min(12, w / 4, h / 4);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w - fold, y);
      ctx.lineTo(x + w, y + fold);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      ctx.fill();
    }
    // body text — centered in the card, word-wrapped to its width, INK
    // explicit when the user chose one, else contrast-chosen for readability
    ctx.globalAlpha = ghost ? 0.55 : 1;
    ctx.fillStyle = a.textColor || stickyInk(a.color);
    ctx.font = '500 ' + M.TEXT_SIZE_PX[a.textSize || 'M'] + 'px ' + MARKUP_FONT;
    ctx.textAlign = 'center';
    wrapText(a.text, x + w / 2, y + 22, w - 18, 16);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  /* ------------- selection chrome: outline + sticky SE resize handle ------- */
  function seHandleRect(a) {
    const r = a.rect;
    return { x: Math.max(r.x, r.x + r.w) - 4, y: Math.max(r.y, r.y + r.h) - 4, w: 8, h: 8 };
  }

  function drawSelectionChrome(a) {
    ctx.save();
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    const r = a.type === 'pen' ? penBounds(a) : a.rect;
    ctx.strokeRect(Math.min(r.x, r.x + r.w) - 5, Math.min(r.y, r.y + r.h) - 5,
      Math.abs(r.w) + 10, Math.abs(r.h) + 10);
    ctx.setLineDash([]);
    if (a.type === 'sticky') {
      const h = seHandleRect(a);
      ctx.fillStyle = '#7c3aed';
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(h.x, h.y, h.w, h.h, 2); else ctx.rect(h.x, h.y, h.w, h.h);
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  function wrapText(text, x, y, maxW, lh) {
    const words = String(text).split(/\s+/);
    let line = '';
    words.forEach((w) => {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, y);
        line = w; y += lh;
      } else line = test;
    });
    if (line) ctx.fillText(line, x, y);
  }

  function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    anns.forEach((a) => drawMark(a, false));
    if (drawing) drawMark(drawing, true);
    const sel = anns.find((a) => a.id === selectedId);
    if (sel) drawSelectionChrome(sel);
  }

  /* ---------------- storage ---------------- */
  async function loadDoc() {
    try {
      const got = await chrome.storage.local.get('orbi_annotations');
      const store = got.orbi_annotations || {};
      const existing = store[M.normalizeUrlKey(url)];
      doc = existing && Array.isArray(existing.annotations) ? existing : M.emptyDoc(url);
    } catch (_) { doc = M.emptyDoc(url); }
    anns = doc.annotations;
    render();
  }

  async function saveDoc() {
    try {
      const got = await chrome.storage.local.get('orbi_annotations');
      const store = got.orbi_annotations || {};
      doc.url = url;
      doc.urlKey = M.normalizeUrlKey(url);
      store[doc.urlKey] = doc;
      await chrome.storage.local.set({ orbi_annotations: store });
    } catch (_) { /* storage full/unavailable — marks stay visible until exit */ }
  }

  /* ---------------- hit testing (select/move) ----------------
     Same geometry as the eraser — hitsMark in markup-core (pen strokes
     point-by-point, others by rect ± 6px pick slop) — wrapped so SELECT
     returns the topmost hit and never races the eraser's semantics. */
  const PICK_SLOP = 6;
  function hitTest(x, y) {
    for (let i = anns.length - 1; i >= 0; i--) {
      if (M.hitsMark(anns[i], x, y, PICK_SLOP)) return anns[i];
    }
    return null;
  }

  /* ---------------- pointer events ---------------- */
  function inRect(x, y, r) {
    return x >= Math.min(r.x, r.x + r.w) && x <= Math.max(r.x, r.x + r.w) &&
           y >= Math.min(r.y, r.y + r.h) && y <= Math.max(r.y, r.y + r.h);
  }

  function onDown(e) {
    if (e.target !== canvas) return;
    const x = e.clientX, y = e.clientY;
    if (tool === 'eraser') {
      // one history entry per erase STROKE (all its removals undo together)
      pushHistory();
      erasing = true;
      const { doc: after, removed } = M.eraseAt(doc, x, y, M.ERASER.RADIUS);
      if (removed.length) {
        doc = after; anns = doc.annotations;
        if (removed.some((a) => a.id === selectedId)) selectedId = null;
      }
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* pointer already released */ }
      render();
      return;
    }
    if (tool === 'select') {
      const sel = anns.find((a) => a.id === selectedId);
      // SE handle of a selected sticky starts a RESIZE — checked BEFORE the
      // hit-test so the handle wins over the card body under it
      if (sel && sel.type === 'sticky' && inRect(x, y, seHandleRect(sel))) {
        sizing = { id: sel.id, last: { x, y } };
        pushHistory(); // resize is one reversible action
        try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* pointer already released */ }
        return;
      }
      const a = hitTest(x, y);
      selectedId = a ? a.id : null;
      if (a) { drag = { id: a.id, dx: x, dy: y }; pushHistory(); } // move is one reversible action
      syncShapePicker();
      render();
      return;
    }
    if (drag || sizing) return; // a captured drag/resize is still in flight — don't start drawing
    drawing = {
      id: M.genId(),
      type: tool,
      color,
      textColor: inkColor || undefined,
      textSize,
      rect: { x, y, w: 0, h: 0 },
      points: tool === 'pen' ? [[x, y]] : undefined,
      text: tool === 'text' ? '' : undefined,
      createdAt: new Date().toISOString()
    };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* pointer already released */ }
  }

  function onMove(e) {
    const x = e.clientX, y = e.clientY;
    if (sizing) {
      const sel = anns.find((a) => a.id === sizing.id);
      if (sel) {
        const { doc: resized } = M.resizeAnnotation(doc, sizing.id, x - sizing.last.x, y - sizing.last.y);
        doc = resized; anns = doc.annotations;
        sizing.last = { x, y };
      } else {
        sizing.last = { x, y };
      }
      render();
      return;
    }
    if (drag) {
      const { doc: moved } = M.moveAnnotation(doc, drag.id, x - drag.dx, y - drag.dy);
      doc = moved; anns = doc.annotations;
      drag.dx = x; drag.dy = y;
      render();
      return;
    }
    // ERASER: drag across the page — every mark the cursor touches goes
    if (tool === 'eraser' && erasing) {
      const { doc: after, removed } = M.eraseAt(doc, x, y, M.ERASER.RADIUS);
      if (removed.length) {
        doc = after; anns = doc.annotations;
        if (removed.some((a) => a.id === selectedId)) selectedId = null;
        render();
      }
      return;
    }
    if (tool === 'select' && !drawing) {
      // SE handle → resize cursor; over a mark → move; else plain
      const sel = anns.find((a) => a.id === selectedId);
      canvas.style.cursor = sel && sel.type === 'sticky' && inRect(x, y, seHandleRect(sel)) ? 'nwse-resize'
        : hitTest(x, y) ? 'move' : 'default';
      return;
    }
    if (!drawing) return;
    if (tool === 'pen') drawing.points.push([x, y]);
    else {
      drawing.rect.w = x - drawing.rect.x;
      drawing.rect.h = y - drawing.rect.y;
    }
    render();
  }

  function onUp(e) {
    if (sizing) { sizing = null; saveDoc(); return; } // resize finished → persist
    if (drag) { drag = null; saveDoc(); return; } // move finished → persist
    if (erasing) { erasing = false; saveDoc(); return; } // erase stroke done → persist
    if (!drawing) return;
    const d = drawing; drawing = null;
    const x = e.clientX, y = e.clientY;

    if (tool === 'text') {
      // Text note: type it now. Commit on Enter or blur (blur was the bug —
      // clicking away used to throw the note away; now it SAVES).
      openTextArea(x, y, (val) => {
        if (val) {
          pushHistory(); // text note creation is one reversible action
          doc = M.addAnnotation(doc, {
            ...d,
            text: val,
            rect: { x, y, w: 260, h: 24 },
            textColor: lastTextCtx ? lastTextCtx.pending : undefined,
            textSize: lastTextCtx ? lastTextCtx.pendingSize : undefined
          }).doc;
          anns = doc.annotations;
          // hand the fresh note to the cursor tool: it's selected + movable,
          // and its color can be changed with one palette click (request 2+3)
          selectedId = anns[anns.length - 1].id;
          setTool('select');
        }
        saveDoc();
        render();
      });
      return;
    }

    const tiny = Math.abs(d.rect.w) < 3 && Math.abs(d.rect.h) < 3 && tool !== 'pen';
    if (tiny) { render(); return; } // accidental click — not a mark

    if (tool === 'sticky') {
      // sticky note: draw the card to size, then type straight INTO it
      openTextArea(Math.max(4, Math.min(d.rect.x, d.rect.x + d.rect.w) + 2),
        Math.max(4, Math.min(d.rect.y, d.rect.y + d.rect.h) + 2), (val) => {
          if (val) {
            pushHistory(); // sticky creation is one reversible action
            doc = M.addAnnotation(doc, {
              ...d,
              text: val,
              textColor: lastTextCtx ? lastTextCtx.pending : undefined,
              textSize: lastTextCtx ? lastTextCtx.pendingSize : undefined
            }).doc;
            anns = doc.annotations;
            selectedId = anns[anns.length - 1].id; // selected → resize/recolor ready
            setTool('select');
          }
          saveDoc(); render();
        }, { placeholder: 'Type inside the note… (Enter to save)' });
      return;
    }

    pushHistory(); // shape creation is one reversible action
    const { doc: added } = M.addAnnotation(doc, d);
    doc = added; anns = doc.annotations;
    const id = anns[anns.length - 1].id;

    // Shape label — optional, offered right after drawing; blur commits it
    openTextArea(x, y, (val) => {
      if (val) {
        pushHistory(); // label add is one reversible action
        doc = M.setAnnotationText(doc, id, val).doc;
        anns = doc.annotations;
      }
      saveDoc(); render();
    }, { atShape: d });
    saveDoc(); render();
  }

  // Double-click an existing mark: sticky/text → edit the body, shapes → label
  function onDblClick(e) {
    if (tool !== 'select' || e.target !== canvas) return;
    const a = hitTest(e.clientX, e.clientY);
    if (!a) return;
    const isBody = a.type === 'sticky' || a.type === 'text';
    openTextArea(e.clientX, e.clientY, (val) => {
      if (val !== (a.text || '')) {
        pushHistory(); // body/label edit is one reversible action
        doc = M.setAnnotationText(doc, a.id, val).doc;
        anns = doc.annotations;
      }
      saveDoc(); render();
    }, {
      initial: a.text || '',
      editId: a.id, // ink clicks now LIVE-recolor this mark while typing
      placeholder: isBody ? 'Edit the note… (Enter to save)' : 'Label… (Enter to save; empty clears)'
    });
  }

  function setTool(t) {
    const b = root && root.querySelector('[data-tool="' + t + '"]');
    if (b) onTool(t, b, b.parentElement);
  }

  /* ---------------- text input (the save-on-blur fix) ---------------- */
  // Used by the text tool, sticky notes, and label edits. Commit on Enter or
  // blur (blur used to throw the note away — now it SAVES); Esc discards.
  function openTextArea(x, y, onDone, opts = {}) {
    const input = document.createElement('textarea');
    input.id = 'mk-text-input';
    input.placeholder = opts.placeholder || 'Type a note… (Enter to save)';
    input.rows = 1;
    let done = false;

    // Ink context: while this input is open, ink clicks either LIVE-recolor
    // the mark being edited (editId) or pend for the note about to be created.
    const editing = opts.editId ? anns.find((a) => a.id === opts.editId) : null;
    activeTextCtx = editing
      ? { id: editing.id, liveColor: undefined, original: editing.textColor ?? null, liveSize: undefined, originalSize: editing.textSize || 'M' }
      : { id: null, pending: inkColor, pendingSize: textSize };

    const at = opts.atShape || { rect: { x, y, w: 0, h: 0 } };
    const isArrow = opts.atShape && opts.atShape.type === 'arrow';
    const isTextTool = opts.atShape && opts.atShape.type === 'text';
    const ax = isArrow ? at.rect.x + at.rect.w + 6 : at.rect.x + 6;
    const ay = !isArrow && !isTextTool
      ? at.rect.y + Math.max(0, at.rect.h / 2 - 14)
      : Math.max(4, y - 10);
    input.style.left = Math.max(4, ax) + 'px';
    input.style.top = Math.max(4, ay) + 'px';
    if (opts.initial) input.value = opts.initial;

    const finish = (save) => {
      if (done) return;
      done = true;                 // Enter, blur or Esc — exactly ONE finish
      const ctx = activeTextCtx;
      activeTextCtx = null;
      const val = input.value.trim();
      input.remove();
      canvas && canvas.focus && canvas.focus();
      // Esc after a live ink/size preview → restore the original look
      if (!save && ctx && ctx.id != null && (ctx.liveColor !== undefined || ctx.liveSize !== undefined)) {
        if (ctx.liveColor !== undefined && ctx.liveColor !== ctx.original) {
          const { doc: restored } = M.setAnnotationTextColor(doc, ctx.id, ctx.original);
          doc = restored; anns = doc.annotations;
        }
        if (ctx.liveSize !== undefined && ctx.liveSize !== ctx.originalSize) {
          const { doc: restored } = M.setAnnotationTextSize(doc, ctx.id, ctx.originalSize);
          doc = restored; anns = doc.annotations;
        }
        if (ctx.liveColor !== undefined || ctx.liveSize !== undefined) {
          undoStack.pop(); // preview was history — an ESC (cancel) removes it
          redoStack = [];
        }
      }
      // hand the pending ink/size (possibly changed mid-typing) to the creator
      lastTextCtx = (ctx && ctx.id == null) ? { pending: ctx.pending, pendingSize: ctx.pendingSize } : null;
      onDone(save ? val : (opts.initial || ''));
    };

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // the page must not see these keys
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    // THE FIX: clicking anywhere else (blur) COMMITS the text instead of
    // dropping it. Escape is the only way to discard an edit.
    input.addEventListener('blur', () => finish(true));

    root.appendChild(input);
    input.focus();
  }

  function flash(msg) {
    const s = root && root.querySelector('.mk-status');
    if (s) { s.textContent = msg; setTimeout(() => { s.textContent = ''; }, 1600); }
  }

  function teardown() {
    saveDoc();
    if (root) root.remove();
    root = canvas = ctx = null;
    undoStack = []; redoStack = [];
    window.removeEventListener('resize', resize);
    delete globalThis.__orbitabsMarkupActive;
    delete globalThis.__orbitabsMarkupSyncPicker;
  }

  /* ---------------- open/close commands ---------------- */
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === 'ORBITABS_MARKUP_OPEN' && msg.url) {
      url = msg.url;
      if (build()) {
        loadDoc();
        if (anns.length > 0) {
          const t = document.createElement('div');
          t.id = 'mk-toast';
          t.textContent = '🖊 ' + anns.length + ' markup' + (anns.length === 1 ? '' : 's') + ' on this page';
          root.appendChild(t);
          setTimeout(() => t.remove(), 4000);
        }
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
    }
    return true;
  });
})();
