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
  let sizing = null;    // { id, last:{x,y} } SE-handle resize of a sticky/text note
  let erasing = false;  // eraser stroke in progress
  let inkColor = null;      // default TEXT ink for new marks (null = auto)
  let textSize = 'M';       // default TEXT size for new marks (S | M | L)
  let activeTextCtx = null; // { id, pending, pendingSize, liveColor, liveSize, original, originalSize } while a text input is open
  let lastTextCtx = null;   // the ctx of the text input that JUST closed (pending ink + size)
  let penWidth = 2;             // stroke width for NEW pen strokes (PEN TOOL box)
  let uiTheme = 'dark';         // overlay-CHROME theme (rail/panels/hint); canvas ink never changes
  let syncThemeBtn = null;      // set by build() — re-renders the theme row + flips .mk-light
  let openBox = null;           // which control box is open: shapes|colors|pen|text
  let dockOffset = { x: 0, y: 0 };  // parked position of the whole dock (translate px)
  let launcherDrag = null;          // { x0, y0, ox, oy, moved } while dragging the dock
  let launcherJustDragged = false;  // a drag's trailing click must NOT toggle minimize
  let recentColors = ['#e935c8', '#1f8a4c', '#e8908f', '#0e7490']; // COLORS "Recent" row (mock seed)
  let renderRecents = null;   // re-renders the Recent row when a fill changes
  const textStyle = { font: null, size: null, align: null, valign: null, bold: false, italic: false, underline: false, leading: null };

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
    rect: '<rect x="3" y="3" width="18" height="18" rx="1"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    arrow: '<path d="M6 6h12v12"/><path d="M6 18 18 6"/>',
    text: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
    sticky: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M20 12h-6v8"/>',
    eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
    clear: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
    exit: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    line: '<path d="M5 19 19 5"/>',
    triangle: '<path d="M12 4 21.5 20.5h-19z"/>',
    star: '<path d="m12 3.6 2.5 5.4 5.9.7-4.4 4 1.2 5.8-5.2-3-5.2 3 1.2-5.8-4.4-4 5.9-.7z"/>',
    minimize: '<path d="M4 9h16"/><path d="m7 6-3 3 3 3"/><path d="M20 15H4"/><path d="m17 12 3 3-3 3"/>',
    droplet: '<path d="M12 2.7s5.7 6.1 5.7 10.1a5.7 5.7 0 0 1-11.4 0c0-4 5.7-10.1 5.7-10.1z"/>',
    move4: '<path d="M12 2v20"/><path d="M2 12h20"/><path d="m9 5 3-3 3 3"/><path d="m9 19 3 3 3-3"/><path d="m5 9-3 3 3 3"/><path d="m19 9 3 3-3 3"/>',
    grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'
  };
  const TOOL_ORDER = ['select', 'pen', 'highlight', 'rect', 'circle', 'arrow', 'text', 'sticky', 'eraser', 'undo', 'redo', 'clear', 'save', 'exit'];
  const NAMES = {
    select: 'Select / Move / Resize — drag marks; SE corner resizes stickies; double-click to label',
    pen: 'Pen', highlight: 'Highlight', rect: 'Rectangle', circle: 'Circle',
    arrow: 'Arrow', text: 'Text note', sticky: 'Sticky note — draw a card, type inside, resize from the corner',
    eraser: 'Eraser — rub across marks to erase only what it touches',
    undo: 'Undo', redo: 'Redo',
    clear: 'Clear this page', save: 'Save annotations', exit: 'Close Markup',
    minimize: 'Minimize the markup toolbar', shape: 'Shapes box', colors: 'Colors box',
    triangle: 'Triangle', star: 'Star'
  };
  // rail order + pill labels, exactly per the labeled mock:
  // minimize · cross · shape · colors · move · Erase · back · undo · pen ·
  // text · (gap) · bin — ONE colors tool only (the second color entry was
  // the same droplet + palette; removed per the latest mock)
  const RAIL_SPEC = [
    ['minimize', 'minimize', 'minimize tool'],
    ['exit', 'exit', 'cross tool'],
    ['shape', 'rect', 'shape tool'],
    ['colors', 'droplet', 'colors tool'],
    ['select', 'move4', 'move tool'],
    ['eraser', 'eraser', 'Erase tool'],
    ['redo', 'redo', 'back tool'],
    ['undo', 'undo', 'undo tool'],
    ['pen', 'pen', 'pen tool'],
    ['text', 'text', 'text tool'],
    ['highlight', 'highlight', 'highlight tool'],
    ['sticky', 'sticky', 'sticky tool'],
    ['clear', 'clear', 'bin tool']
  ];
  const BOX_KEYS = ['shapes', 'colors', 'pen', 'text'];

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

    /* ── right-side dock: stacked control panels + labeled vertical rail
       (the light panel/rail design from ui/markup.png) ── */
    const dock = document.createElement('div');
    dock.id = 'mk-dock';
    const panels = document.createElement('div');
    panels.id = 'mk-panels';

    const panel = (title, bodyCls) => {
      const p = document.createElement('div');
      p.className = 'mk-panel';
      const t = document.createElement('div');
      t.className = 'mk-panel-title';
      t.textContent = title;
      const body = document.createElement('div');
      body.className = 'mk-panel-body' + (bodyCls ? ' ' + bodyCls : '');
      p.appendChild(t);
      p.appendChild(body);
      panels.appendChild(p);
      return body;
    };

    const toolButton = (t, cls) => {
      const b = document.createElement('button');
      b.appendChild(svgIcon(t));
      // aria-label, NOT title: the custom .mk-pill IS this button's tooltip
      // (revealed on hover) — a native title would double up on top of it
      b.setAttribute('aria-label', NAMES[t]);
      b.dataset.tool = t;
      if (t === 'clear') b.classList.add('mk-danger');
      if (t === tool) b.classList.add('mk-active');
      if (cls) b.classList.add(cls);
      b.addEventListener('click', () => onTool(t, b));
      return b;
    };

    const mkBox = (key, title, bodyCls) => {
      const body = panel(title, bodyCls);
      body.parentElement.classList.add('mk-box', 'mk-box-' + key);
      return body;
    };

    // ── COLOR-ROW FACTORIES (user request: every tool box carries the colors
    // setting, styled exactly like the COLORS box). Rows share the .mk-swatches
    // / .mk-swatch classes + data-color, so selectSwatch/markInkActive keep
    // EVERY row in the overlay in sync (they match swatches by data-color).
    const mkColorLabel = (txt) => {
      const l = document.createElement('div');
      l.className = 'mk-mini-label';
      l.textContent = txt;
      return l;
    };
    const mkFillRow = () => {
      const row = document.createElement('div');
      row.className = 'mk-swatches mk-box-swatches';
      M.COLORS.forEach((c) => {
        const b = document.createElement('button');
        b.className = 'mk-swatch';
        b.style.background = c;
        b.dataset.color = c;
        b.title = 'Color';
        b.addEventListener('click', () => selectSwatch(c, b));
        row.appendChild(b);
      });
      return row;
    };

    // SHAPES box — the six shapes from the mock (square · line · arrow /
    // circle · triangle · star); line = pen, its settings live in PEN TOOL.
    // Stroke weights differ per the mock: the diagonal line is THIN and the
    // arrow is BOLD; everything else keeps the standard 2.
    const SHAPE_STROKE = { pen: 1.5, arrow: 3 };
    const shapesBody = mkBox('shapes', 'SHAPES', 'mk-shapes-grid');
    [['rect', 'rect'], ['pen', 'line'], ['arrow', 'arrow'],
     ['circle', 'circle'], ['triangle', 'triangle'], ['star', 'star']].forEach(([t, ic]) => {
      const b = document.createElement('button');
      b.className = 'mk-shape-btn';
      const svg = svgIcon(ic);
      if (SHAPE_STROKE[t]) svg.setAttribute('stroke-width', SHAPE_STROKE[t]);
      b.appendChild(svg);
      b.title = NAMES[t];
      b.dataset.tool = t;
      if (t === tool) b.classList.add('mk-active');
      b.addEventListener('click', () => onTool(t, b));
      shapesBody.appendChild(b);
    });
    shapesBody.appendChild(mkColorLabel('Color'));
    shapesBody.appendChild(mkFillRow());

    // COLORS box: palette circles + 🎨 ring, "Recent" row, text-ink row
    const colorsBody = mkBox('colors', 'COLORS', 'mk-colors-box');
    const swatches = document.createElement('div');
    swatches.className = 'mk-swatches mk-fill-swatches';
    M.COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'mk-swatch' + (i === 0 ? ' mk-active' : '');
      b.style.background = c;
      b.dataset.color = c;
      b.title = 'Color';
      b.addEventListener('click', () => selectSwatch(c, b));
      swatches.appendChild(b);
    });
    // 🎨 full-palette escape hatch — the ring opens the INLINE palette below
    // (SV area · hue slider · alpha slider · eyedropper · hex + % fields),
    // per the mock's color picker. No native input — everything is ours.
    const custom = document.createElement('button');
    custom.className = 'mk-swatch mk-custom';
    custom.title = 'Any color…'; // styled as a ring in the COLORS box
    swatches.appendChild(custom);
    colorsBody.appendChild(swatches);

    // "Recent" row — last-used fills, seeded like the mock's muted row
    const recentLabel = document.createElement('div');
    recentLabel.className = 'mk-mini-label';
    recentLabel.textContent = 'Recent';
    colorsBody.appendChild(recentLabel);
    const recentRow = document.createElement('div');
    recentRow.className = 'mk-swatches mk-recent-swatches';
    colorsBody.appendChild(recentRow);
    renderRecents = () => {
      recentRow.innerHTML = '';
      recentColors.forEach((c) => {
        const b = document.createElement('button');
        b.className = 'mk-swatch';
        b.style.background = c;
        b.dataset.color = c;
        b.title = 'Recent color';
        b.addEventListener('click', () => selectSwatch(c, b));
        recentRow.appendChild(b);
      });
    };
    renderRecents();

    // Ink (TEXT color) row — shared FACTORY: the COLORS box AND the TEXT box
    // both wear this row (ink can be recolored AFTER typing and even WHILE
    // typing — live preview on edits).
    // shared <input type=color> opener for both ink pickers
    const inkPicker = (btn) => {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = inkColor || '#111827';
      wireColorInput(inp, () => selectInkSwatch(inp.value, btn));
      try { inp.showPicker(); } catch (_) { inp.click(); }
    };
    const mkInkRow = () => {
      const row = document.createElement('div');
      row.className = 'mk-swatches mk-ink-swatches';
      const mkInkBtn = (c, label) => {
        const b = document.createElement('button');
        b.className = 'mk-swatch';
        if (c) { b.style.background = c; b.dataset.color = c; }
        b.title = label;
        b.addEventListener('click', () => selectInkSwatch(c, b));
        row.appendChild(b);
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
      inkCustom.addEventListener('click', () => inkPicker(inkCustom));
      row.appendChild(inkCustom);
      return row;
    };
    const inkRow = mkInkRow();

    // ── custom palette (the mock's DevTools-style picker) ──────────────────
    // Opens from the 🎨 ring above. Drags live-preview the knobs + hex field;
    // release (or Enter/blur) COMMITS through selectSwatch — one click, one
    // undo step, recents updated once. Alpha rides along as 8-digit hex.
    const palette = document.createElement('div');
    palette.className = 'mk-palette';
    const sv = document.createElement('div');
    sv.className = 'mk-pal-sv';
    const svKnob = document.createElement('div');
    svKnob.className = 'mk-pal-knob';
    sv.appendChild(svKnob);
    const palRow = document.createElement('div');
    palRow.className = 'mk-pal-row';
    const eyeBtn = document.createElement('button');
    eyeBtn.className = 'mk-eyedrop';
    eyeBtn.title = 'Pick from the page';
    eyeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>';
    if (typeof window.EyeDropper !== 'function') eyeBtn.style.display = 'none'; // API gate
    const sliders = document.createElement('div');
    sliders.className = 'mk-pal-sliders';
    const mkTrack = (cls) => {
      const t = document.createElement('div');
      t.className = cls;
      const k = document.createElement('div');
      k.className = 'mk-pal-knob';
      t.appendChild(k);
      sliders.appendChild(t);
      return [t, k];
    };
    const hueTrack = mkTrack('mk-pal-hue');
    const alphaTrack = mkTrack('mk-pal-alpha');
    palRow.append(eyeBtn, sliders);
    const hexRow = document.createElement('div');
    hexRow.className = 'mk-pal-row';
    const hexChip = document.createElement('span');
    hexChip.className = 'mk-pal-chip';
    hexChip.textContent = 'Hex';
    const hexInp = document.createElement('input');
    hexInp.className = 'mk-pal-hex';
    hexInp.spellcheck = false;
    hexInp.title = 'Hex color — RRGGBB, or RRGGBBAA for opacity';
    const pctInp = document.createElement('input');
    pctInp.className = 'mk-pal-pct';
    pctInp.type = 'number';
    pctInp.min = '0'; pctInp.max = '100';
    pctInp.title = 'Opacity %';
    const pctSign = document.createElement('span');
    pctSign.className = 'mk-pal-sign';
    pctSign.textContent = '%';
    hexRow.append(hexChip, hexInp, pctInp, pctSign);
    palette.append(sv, palRow, hexRow);
    colorsBody.appendChild(palette);

    // palette state: HSV + alpha, seeded from the current color on open
    let palH = 0, palS = 1, palV = 1, palA = 1;
    const rgbToHsv = (r, g, b) => {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      let h = 0;
      if (d) {
        if (mx === r) h = ((g - b) / d) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      return [h, mx ? d / mx : 0, mx];
    };
    const hsvToRgb = (h, s, v) => {
      const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
      const t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
      return [(t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255];
    };
    const palHex6 = () => hsvToRgb(palH, palS, palV)
      .map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
    const palHex = () => '#' + palHex6() +
      (palA < 1 ? Math.round(palA * 255).toString(16).padStart(2, '0') : '');
    const seedFromHex = (hex) => {
      const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex || '').trim());
      if (!m) return false;
      const n = parseInt(m[1], 16);
      const hsv = rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255);
      palH = hsv[0]; palS = hsv[1]; palV = hsv[2];
      palA = m[2] ? parseInt(m[2], 16) / 255 : 1;
      return true;
    };
    const paintPalette = () => {
      const hsl = 'hsl(' + Math.round(palH) + ', 100%, 50%)';
      // hue base + white→transparent (S) + transparent→black (V)
      sv.style.background =
        'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0)), ' + hsl;
      svKnob.style.left = (palS * 100) + '%';
      svKnob.style.top = ((1 - palV) * 100) + '%';
      svKnob.style.background = palHex();
      const rgb = hsvToRgb(palH, palS, palV).map((n) => Math.round(n));
      hueTrack[1].style.left = (palH / 360 * 100) + '%';
      hueTrack[1].style.background = hsl;
      // alpha track: color→transparent gradient over a transparency checker
      alphaTrack[0].style.background =
        'linear-gradient(to right, rgba(' + rgb.join(',') + ',0), rgba(' + rgb.join(',') + ',1)),' +
        ' repeating-conic-gradient(#fff 0 25%, #cfcfcf 0 50%) 0 0 / 8px 8px';
      alphaTrack[1].style.left = (palA * 100) + '%';
      alphaTrack[1].style.background = 'rgba(' + rgb.join(',') + ',' + palA + ')';
      if (document.activeElement !== hexInp) hexInp.value = palHex().slice(1).toUpperCase();
      if (document.activeElement !== pctInp) pctInp.value = String(Math.round(palA * 100));
    };
    // commit = one selectSwatch call: color set, ring marked active, recents
    // updated, selected mark recolored (one history entry), canvas re-rendered
    const commitPal = () => {
      const hex = palHex();
      custom.style.background = hex;
      selectSwatch(hex, custom);
    };
    let palOpen = false;
    custom.addEventListener('click', () => {
      palOpen = !palOpen;
      palette.classList.toggle('mk-open', palOpen);
      if (palOpen) { seedFromHex(color); paintPalette(); renderOnPage(scanPageColors()); }
    });
    // shared drag plumbing for the SV area + both sliders: pointer capture,
    // live knob/hex preview while moving, ONE commit on release
    const dragTrack = (el, apply) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* pointer already released */ }
        const at = (ev) => {
          const r = el.getBoundingClientRect();
          apply(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
                Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
          paintPalette();
        };
        const stop = () => {
          el.removeEventListener('pointermove', at);
          el.removeEventListener('pointerup', stop);
          el.removeEventListener('pointercancel', stop);
          commitPal();
        };
        el.addEventListener('pointermove', at);
        el.addEventListener('pointerup', stop);
        el.addEventListener('pointercancel', stop);
        at(e);
      });
    };
    dragTrack(sv, (_fx, fy) => { palS = _fx; palV = 1 - fy; });
    dragTrack(hueTrack[0], (fx) => { palH = Math.min(359.99, fx * 360); });
    dragTrack(alphaTrack[0], (fx) => { palA = fx; });
    // hex field: Enter commits, Esc snaps back, blur commits (save-on-blur,
    // same contract as the note textarea)
    const applyHexInput = () => {
      if (seedFromHex(hexInp.value)) { paintPalette(); commitPal(); }
      else paintPalette(); // invalid → restore the real value
    };
    hexInp.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the page must not see these keys
      if (e.key === 'Enter') { e.preventDefault(); applyHexInput(); }
      if (e.key === 'Escape') paintPalette();
    });
    hexInp.addEventListener('change', applyHexInput);
    hexInp.addEventListener('click', (e) => e.stopPropagation());
    pctInp.addEventListener('change', () => {
      const n = Math.max(0, Math.min(100, Number(pctInp.value) || 0));
      palA = n / 100;
      paintPalette(); commitPal();
    });
    pctInp.addEventListener('keydown', (e) => e.stopPropagation());
    // eyedropper — EyeDropper API (Chrome 95+); user cancel just dismisses
    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        new window.EyeDropper().open().then((res) => {
          if (res && res.sRGBHex && seedFromHex(res.sRGBHex)) { paintPalette(); commitPal(); }
        }).catch(() => {});
      } catch (_) { /* picker unavailable */ }
    });

    // ── "On this page" — the mock's swatch grid of colors the page itself
    // uses. Harvested from computed color + background-color (overlay
    // excluded), tally → top 32, collapsible under a caret header.
    const onPage = document.createElement('div');
    onPage.className = 'mk-pal-page';
    const onPageHead = document.createElement('button');
    onPageHead.className = 'mk-pal-page-head';
    onPageHead.innerHTML = '<span>On this page</span><svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.2 6 8.2 10 4.2"/></svg>';
    const onPageGrid = document.createElement('div');
    onPageGrid.className = 'mk-pal-page-grid';
    onPage.append(onPageHead, onPageGrid);
    palette.appendChild(onPage);
    onPageHead.addEventListener('click', (e) => {
      e.stopPropagation();
      onPage.classList.toggle('mk-collapsed');
    });
    const scanPageColors = () => {
      const counts = new Map();
      const add = (css) => {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(css || '');
        if (!m) return;
        const a = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (a <= 0) return; // invisible — nothing to pick
        const hex = '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('') +
          (a < 1 ? Math.round(a * 255).toString(16).padStart(2, '0') : '');
        counts.set(hex, (counts.get(hex) || 0) + 1);
      };
      let n = 0;
      const all = document.body.getElementsByTagName('*');
      for (let i = 0; i < all.length && n < 2500; i++) {
        const el = all[i];
        if (root.contains(el)) continue; // never sample our own dock
        n++;
        const cs = getComputedStyle(el);
        add(cs.color);
        add(cs.backgroundColor);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 32)
        .map(([hex]) => hex);
    };
    const renderOnPage = (hexes) => {
      onPageGrid.innerHTML = '';
      hexes.forEach((hex) => {
        const b = document.createElement('button');
        b.className = 'mk-swatch mk-page-swatch';
        b.style.background = hex;
        b.title = hex.toUpperCase();
        b.addEventListener('click', () => {
          if (seedFromHex(hex)) { paintPalette(); commitPal(); }
        });
        onPageGrid.appendChild(b);
      });
    };

    const mini = document.createElement('div');
    mini.className = 'mk-mini-label';
    mini.textContent = 'Text color';
    colorsBody.appendChild(mini);
    colorsBody.appendChild(inkRow);

    // Text-size picker — S/M/L for notes, stickies and labels. Same three
    // contexts as ink: default for NEW marks, live on the note being typed,
    // instant on the selected mark.
    const mkSizeBtn = (s) => {
      const b = document.createElement('button');
      b.className = 'mk-size-btn' + (s === textSize ? ' mk-active' : '');
      b.textContent = s;
      b.dataset.size = s;
      b.title = 'Text size: ' + s;
      b.addEventListener('click', () => selectTextSize(s, b));
      return b;
    };

    // PEN TOOL box — per the mock: the tool name sits ABOVE a light preview
    // chip (wavy stroke + caret) with the width select beside it. Each preset
    // has its own stroke character: thin pencil · tapered marker · fuzzy brush
    // (an SVG turbulence filter roughs the brush edge).
    const penBody = mkBox('pen', 'PEN TOOL', 'mk-pen-box');
    const penRows = [];
    [{ name: 'Pencil', width: 2, sw: 1.5 }, { name: 'Marker', width: 5, sw: 3.5 },
     { name: 'Brush', width: 9, sw: 7, fuzz: true }].forEach((p) => {
      const wrap = document.createElement('div');
      wrap.className = 'mk-pen-tool';
      const nm = document.createElement('div');
      nm.className = 'mk-pen-name';
      nm.textContent = p.name;
      const line = document.createElement('div');
      line.className = 'mk-pen-line';
      const chip = document.createElement('div');
      chip.className = 'mk-pen-chip';
      const prev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      prev.setAttribute('class', 'mk-pen-preview');
      prev.setAttribute('viewBox', '0 0 64 18');
      prev.innerHTML = (p.fuzz
        ? '<defs><filter id="mk-brush-fuzz" x="-20%" y="-40%" width="140%" height="180%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G"/></filter></defs>'
        : '') +
        '<path d="M3 12 C 14 4, 26 16, 40 9 S 56 6, 61 9" fill="none" stroke="currentColor" stroke-linecap="round"' +
        (p.fuzz ? ' filter="url(#mk-brush-fuzz)"' : '') + '/>';
      prev.querySelector('path').setAttribute('stroke-width', p.sw);
      const caret = document.createElement('span');
      caret.className = 'mk-pen-caret';
      caret.innerHTML = '<svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.2 6 8.2 10 4.2"/></svg>';
      chip.append(prev, caret);
      const sel = document.createElement('select');
      sel.className = 'mk-pen-width';
      [2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 18, 24, 27].forEach((n) => {
        const o = document.createElement('option');
        o.value = String(n);
        o.textContent = String(n);
        if (n === p.width) o.selected = true;
        sel.appendChild(o);
      });
      const activate = () => {
        penWidth = p.width;
        penRows.forEach((r) => r.classList.remove('mk-active'));
        wrap.classList.add('mk-active');
        pop(wrap); // width-pick confirm bounce
        if (tool !== 'pen') setTool('pen');
      };
      sel.addEventListener('change', () => {
        p.width = Number(sel.value);
        prev.querySelector('path').setAttribute('stroke-width', p.width);
        activate();
      });
      sel.addEventListener('click', (e) => e.stopPropagation());
      wrap.addEventListener('click', activate);
      line.append(chip, sel);
      wrap.append(nm, line);
      penBody.appendChild(wrap);
      penRows.push(wrap);
    });
    penRows[0].classList.add('mk-active');
    penBody.appendChild(mkColorLabel('Color'));
    penBody.appendChild(mkFillRow());

    // TEXT box — font style · size (px + L/M/S) · align + valign · B/U/I · spacing
    const textBox = mkBox('text', 'TEXT', 'mk-text-box');
    const mkFieldLabel = (txt) => {
      const l = document.createElement('div');
      l.className = 'mk-field-label';
      l.textContent = txt;
      textBox.appendChild(l);
      return l;
    };
    mkFieldLabel('font style');
    const fontSel = document.createElement('select');
    fontSel.className = 'mk-font-select';
    [['', 'System'], ['Inter', 'Inter'], ['Segoe UI', 'Segoe UI'], ['Arial', 'Arial'], ['Georgia', 'Georgia'],
     ['Times New Roman', 'Times New Roman'], ['Courier New', 'Courier New'],
     ['Verdana', 'Verdana']].forEach(([v, n]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = n;
      fontSel.appendChild(o);
    });
    fontSel.addEventListener('change', () => applyStyle({ font: fontSel.value || null }));
    textBox.appendChild(fontSel);

    mkFieldLabel('font size');
    const sizeRow = document.createElement('div');
    sizeRow.className = 'mk-text-row';
    // exact px select (padded, per the mock) — an explicit px overrides S/M/L
    const sizeSel = document.createElement('select');
    sizeSel.className = 'mk-size-select';
    sizeSel.title = 'Font size (px)';
    [6, 8, 10, 12, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 42, 48].forEach((px) => {
      const o = document.createElement('option');
      o.value = String(px);
      o.textContent = String(px).padStart(2, '0');
      sizeSel.appendChild(o);
    });
    sizeSel.addEventListener('change', () => {
      applyStyle({ size: Number(sizeSel.value) });
      root.querySelectorAll('.mk-size-swatches .mk-size-btn').forEach((b) => b.classList.remove('mk-active'));
    });
    const sizeGrp = document.createElement('div');
    sizeGrp.className = 'mk-swatches mk-size-swatches';
    ['L', 'M', 'S'].forEach((s) => sizeGrp.appendChild(mkSizeBtn(s)));
    sizeRow.append(sizeSel, sizeGrp);
    textBox.appendChild(sizeRow);

    mkFieldLabel('Alignment');
    const alignRow = document.createElement('div');
    alignRow.className = 'mk-text-row';
    const alignGrp = document.createElement('div');
    alignGrp.className = 'mk-btn-group';
    const ALIGN_ICON = {
      left: '<path d="M3 6h18M3 12h10M3 18h14"/>',
      center: '<path d="M3 6h18M7 12h10M5 18h14"/>',
      right: '<path d="M3 6h18M11 12h10M7 18h14"/>'
    };
    ['left', 'center', 'right'].forEach((v) => {
      const b = document.createElement('button');
      b.className = 'mk-align-btn';
      b.dataset.align = v;
      b.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' + ALIGN_ICON[v] + '</svg>';
      b.title = 'Align ' + v;
      b.addEventListener('click', () => {
        applyStyle({ align: textStyle.align === v ? null : v });
        syncTextControls();
      });
      alignGrp.appendChild(b);
    });
    // vertical alignment (top · middle · bottom of the note/card) — the
    // bar-and-box icons from the mock
    const valignGrp = document.createElement('div');
    valignGrp.className = 'mk-btn-group';
    const VALIGN_ICON = {
      top: '<path d="M4 4h16"/><rect x="7" y="9" width="10" height="11" rx="1.5"/>',
      middle: '<rect x="7" y="3" width="10" height="18" rx="1.5"/><path d="M3 12h18"/>',
      bottom: '<rect x="7" y="4" width="10" height="11" rx="1.5"/><path d="M4 20h16"/>'
    };
    ['top', 'middle', 'bottom'].forEach((v) => {
      const b = document.createElement('button');
      b.className = 'mk-valign-btn';
      b.dataset.valign = v;
      b.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' + VALIGN_ICON[v] + '</svg>';
      b.title = 'Vertical align: ' + v;
      b.addEventListener('click', () => {
        applyStyle({ valign: textStyle.valign === v ? null : v });
        syncTextControls();
      });
      valignGrp.appendChild(b);
    });
    alignRow.append(alignGrp, valignGrp);
    textBox.appendChild(alignRow);

    const styleRow = document.createElement('div');
    styleRow.className = 'mk-text-row mk-style-row';
    [['bold', 'B'], ['underline', 'U'], ['italic', 'I']].forEach(([k, ch]) => {
      const b = document.createElement('button');
      b.className = 'mk-style-btn mk-style-' + k;
      b.textContent = ch;
      b.title = k.charAt(0).toUpperCase() + k.slice(1);
      b.addEventListener('click', () => {
        applyStyle({ [k]: !textStyle[k] });
        syncTextControls();
      });
      styleRow.appendChild(b);
    });
    // line spacing — cycles default → 1.25× → 1.5× → 2× → default
    const LEADS = [null, 1.25, 1.5, 2];
    const spaceBtn = document.createElement('button');
    spaceBtn.className = 'mk-space-btn';
    spaceBtn.title = 'Line spacing';
    spaceBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v16M4 4l-2 2.6M4 4l2-2.6M4 20l-2 2.6M4 20l2-2.6"/><path d="M9 5h11M9 12h11M9 19h11"/></svg>';
    spaceBtn.addEventListener('click', () => {
      const i = LEADS.indexOf(textStyle.leading);
      const next = LEADS[(i + 1) % LEADS.length];
      applyStyle({ leading: next });
      syncTextControls();
    });
    styleRow.appendChild(spaceBtn);
    textBox.appendChild(styleRow);

    // ink row — the TEXT box carries the colors setting itself now (the
    // COLORS box keeps its own copy; both stay in sync via data-color)
    textBox.appendChild(mkColorLabel('Text color'));
    textBox.appendChild(mkInkRow());

    // the rail: minimize · cross · shape · colors · move · Erase · back ·
    // undo · pen · text · (gap) · bin — the pill label for each icon is
    // hidden at rest and REVEALS on hover/focus (CSS: .mk-pill)
    TOOL_ORDER.forEach((t) => { if (!NAMES[t]) NAMES[t] = t; }); // every tool has a title
    const rail = document.createElement('div');
    rail.id = 'mk-rail';
    const launcher = toolButton('minimize', 'mk-launcher');
    // the top square is the Orbitabs "O" mark (per the mock), not a tool icon;
    // it toggles minimize on CLICK and drags the whole dock on MOVE
    launcher.innerHTML = '<span class="mk-o" aria-hidden="true">O</span>';
    launcher.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // primary button only
      e.preventDefault();         // no native drag / text selection
      launcherJustDragged = false; // fresh interaction — clear any stale flag
      launcherDrag = { x0: e.clientX, y0: e.clientY, ox: dockOffset.x, oy: dockOffset.y, moved: false };
      try { launcher.setPointerCapture(e.pointerId); } catch (_) { /* pointer already released */ }
      const d = root && root.querySelector('#mk-dock');
      if (d) d.classList.add('mk-dragging');
    });
    launcher.addEventListener('pointermove', (e) => {
      if (!launcherDrag) return;
      const dx = e.clientX - launcherDrag.x0, dy = e.clientY - launcherDrag.y0;
      if (!launcherDrag.moved && Math.abs(dx) + Math.abs(dy) < 5) return; // click threshold
      launcherDrag.moved = true;
      dockOffset = clampDockOffset(launcherDrag.ox + dx, launcherDrag.oy + dy);
      applyDockPos();
    });
    const endLauncherDrag = (e) => {
      if (!launcherDrag) return;
      launcherJustDragged = launcherDrag.moved; // real drag → swallow the click
      launcherDrag = null;
      try { launcher.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
      const d = root && root.querySelector('#mk-dock');
      if (d) d.classList.remove('mk-dragging');
      if (launcherJustDragged) saveDockPos();
    };
    launcher.addEventListener('pointerup', endLauncherDrag);
    launcher.addEventListener('pointercancel', endLauncherDrag);

    RAIL_SPEC.forEach(([t, icon, label]) => {
      if (t === 'clear') {
        const gap = document.createElement('div');
        gap.className = 'mk-rail-gap';
        rail.appendChild(gap);
      }
      const b = toolButton(t);
      b.innerHTML = '';
      b.appendChild(svgIcon(icon));
      const row = document.createElement('div');
      row.className = 'mk-rail-row';
      const pill = document.createElement('span');
      pill.className = 'mk-pill';
      pill.textContent = label;
      row.appendChild(b);
      row.appendChild(pill);
      rail.appendChild(row);
    });

    // 🌗 THEME row — light/dark for the overlay CHROME only (panels, rail,
    // hint, text box); canvas ink and saved marks never change. Persists to
    // storage and syncs live across open pages (storage.onChanged below).
    // Same row+pill structure as the tool buttons; NO data-tool so the
    // active-tool syncs never touch it.
    const themeBtn = document.createElement('button');
    themeBtn.className = 'mk-theme-btn';
    themeBtn.dataset.mk = 'theme';
    themeBtn.setAttribute('aria-label', 'theme tool');
    const themePill = document.createElement('span');
    themePill.className = 'mk-pill';
    syncThemeBtn = () => {
      themeBtn.innerHTML = '';
      themeBtn.appendChild(svgIcon(uiTheme === 'light' ? 'moon' : 'sun'));
      // light theme shows the ACTION (switch to dark), and vice versa
      themePill.textContent = uiTheme === 'light' ? 'dark mode' : 'light mode';
      if (root) root.classList.toggle('mk-light', uiTheme === 'light');
    };
    themeBtn.addEventListener('click', () => {
      uiTheme = uiTheme === 'light' ? 'dark' : 'light';
      syncThemeBtn();
      try { chrome.storage.local.set({ orbi_markup_theme: uiTheme }); }
      catch (_) { /* storage unavailable — this page still toggles */ }
    });
    const themeRow = document.createElement('div');
    themeRow.className = 'mk-rail-row';
    themeRow.appendChild(themeBtn);
    themeRow.appendChild(themePill);
    syncThemeBtn();
    rail.appendChild(themeRow);

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
    panels.appendChild(shapes);

    const hint = document.createElement('div');
    hint.id = 'mk-hint';
    hint.textContent = 'Draw with a tool — cursor tool moves marks (double-click to label; click a mark, then a color, to recolor). Nothing on the website itself is changed.';
    dock.appendChild(panels);
    const railGroup = document.createElement('div');
    railGroup.className = 'mk-rail-group';
    railGroup.appendChild(launcher);
    railGroup.appendChild(rail);
    dock.appendChild(railGroup);
    // status line under the rail — flash('Saved ✓') and friends have a real
    // target (CSS hides it while empty)
    const status = document.createElement('div');
    status.className = 'mk-status';
    dock.appendChild(status);
    root.appendChild(dock);
    root.appendChild(hint);

    document.documentElement.appendChild(root);
    globalThis.__orbitabsMarkupActive = true;
    globalThis.__orbitabsMarkupSyncPicker = syncShapePicker; // harness hook
    undoStack = []; redoStack = [];

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('touchstart', stopTouchPan, { passive: false });
    canvas.addEventListener('touchmove', stopTouchPan, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true }); // CAPTURE: element scrolls don't bubble
    resize();
    loadDockPos(); // restore the last parked spot (clamped to this viewport)
    loadUiTheme(); // restore the user's light/dark choice for the chrome
    if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
      chrome.storage.onChanged.addListener(onThemeChanged); // live cross-page sync
    }
    return true;
  }

  // One place for color selection: sets the drawing color, marks the active
  // swatch, and — when a mark is selected — RECOLORS it live (request 3).
  function selectSwatch(c, btn) {
    color = c;
    // sync EVERY fill row in the overlay (COLORS box + pen/shapes boxes) by
    // data-color — one source of truth, no matter which row was clicked
    root.querySelectorAll('.mk-swatches:not(.mk-ink-swatches) .mk-swatch').forEach((s) => {
      s.classList.toggle('mk-active', s.dataset.color === c);
    });
    if (btn) btn.classList.add('mk-active'); // the 🎨 ring (no data-color) follows too
    pop(btn); // color-pick confirm bounce
    // the Recent row follows the chosen fill
    recentColors = [c, ...recentColors.filter((x) => x !== c)].slice(0, 4);
    if (renderRecents) renderRecents();
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
    root.querySelectorAll('.mk-ink-swatches .mk-swatch').forEach((s) => {
      if (s.classList.contains('mk-ink-custom')) return; // ring only follows explicit clicks
      s.classList.toggle('mk-active', (s.dataset.color || null) === (inkColor || null));
    });
    if (btn) { btn.classList.add('mk-active'); pop(btn); }
  }

  function selectInkSwatch(c, btn) {
    inkColor = c || null;
    markInkActive(btn);
    root.querySelectorAll('.mk-ink-indicator').forEach((b) => { b.style.background = inkColor || 'linear-gradient(90deg,#111827,#f8fafc)'; });
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
    if (btn) { btn.classList.add('mk-active'); pop(btn); }
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

  /* ---------------- control boxes (shape · colors · pen · text) -----------
     Each box opens from its rail icon; only one is open at a time. */
  function closeBoxes() {
    if (!root) return;
    openBox = null;
    root.querySelectorAll('.mk-box').forEach((b) => b.classList.remove('mk-open'));
    syncBoxButtons();
  }

  function toggleBox(key) {
    if (!root || !BOX_KEYS.includes(key)) return;
    const wasOpen = openBox === key;
    closeBoxes();
    if (wasOpen) return;
    openBox = key;
    const b = root.querySelector('.mk-box-' + key);
    if (b) b.classList.add('mk-open');
    syncBoxButtons();
  }

  function syncBoxButtons() {
    root.querySelectorAll('[data-tool]').forEach((b) => {
      const t = b.dataset.tool;
      b.classList.toggle('mk-box-open',
        (t === 'shape' && openBox === 'shapes') ||
        (t === 'colors' && openBox === 'colors') ||
        (t === 'pen' && openBox === 'pen') ||
        (t === 'text' && openBox === 'text'));
    });
  }

  // TEXT box: defaults for NEW marks + live edit of the selected/edited mark
  function applyStyle(patch) {
    Object.assign(textStyle, patch);
    const tctx = activeTextCtx;
    const targetId = (tctx && tctx.id) || selectedId;
    if (targetId) {
      pushHistory();
      const { doc: upd } = M.setAnnotationStyle(doc, targetId, patch);
      doc = upd; anns = doc.annotations;
      saveDoc();
    }
    render();
  }

  // The TEXT box mirrors the SELECTED mark's style (loaded into textStyle on
  // selection); with nothing selected the controls keep serving as defaults
  // for the next mark.
  function syncTextControls() {
    if (!root) return;
    const a = anns.find((x) => x.id === selectedId);
    if (a) {
      textStyle.font = a.font || null;
      textStyle.size = a.size || null;
      textStyle.align = a.align || null;
      textStyle.valign = a.valign || null;
      textStyle.bold = !!a.bold;
      textStyle.italic = !!a.italic;
      textStyle.underline = !!a.underline;
      textStyle.leading = a.leading || null;
    }
    const fontSel = root.querySelector('.mk-font-select');
    if (fontSel) fontSel.value = textStyle.font || '';
    const sizeSel = root.querySelector('.mk-size-select');
    if (sizeSel) sizeSel.value = String(textStyle.size || M.TEXT_SIZE_PX[textSize]);
    root.querySelectorAll('.mk-size-swatches .mk-size-btn').forEach((b) =>
      b.classList.toggle('mk-active', !textStyle.size && b.dataset.size === textSize));
    root.querySelectorAll('.mk-align-btn').forEach((b) =>
      b.classList.toggle('mk-active', b.dataset.align === (textStyle.align || '')));
    root.querySelectorAll('.mk-valign-btn').forEach((b) =>
      b.classList.toggle('mk-active', b.dataset.valign === (textStyle.valign || '')));
    ['bold', 'italic', 'underline'].forEach((k) => {
      const b = root.querySelector('.mk-style-' + k);
      if (b) b.classList.toggle('mk-active', !!textStyle[k]);
    });
    const sp = root.querySelector('.mk-space-btn');
    if (sp) {
      sp.classList.toggle('mk-active', !!textStyle.leading);
      sp.title = 'Line spacing' + (textStyle.leading ? ': ' + textStyle.leading + '\u00d7' : ' (default)');
    }
  }

  function onTool(t, btn) {
    if (t === 'minimize') {
      // the trailing click of a real drag must NOT toggle minimize — the O
      // square is the dock's drag handle, and only a click under the
      // movement threshold counts as the minimize/expand toggle
      if (launcherJustDragged) { launcherJustDragged = false; return; }
      const d = root && root.querySelector('#mk-dock');
      if (d) d.classList.toggle('mk-collapsed');
      return;
    }
    if (t === 'shape' || t === 'colors') {
      toggleBox(t === 'shape' ? 'shapes' : 'colors');
      return;
    }
    if (t === 'pen' || t === 'text') toggleBox(t === 'pen' ? 'pen' : 'text');
    if (t === 'select' || t === 'eraser' || M.TOOLS.includes(t)) {
      if (t === 'select' || t === 'eraser') closeBoxes(); // non-box tools clear the panel
      tool = t;
      if (t !== 'select') selectedId = null; // drawing tools drop the selection
      // eraser: clear the inline cursor so CSS `#mk-canvas.mk-erasing` owns it —
      // the ring cursor (a CIRCLE at the erase radius) replaces the old 'cell'
      // plus, which users misread as "add".
      canvas.classList.toggle('mk-erasing', t === 'eraser');
      canvas.style.cursor = t === 'eraser' ? '' : t === 'select' ? 'default' : 'crosshair';
      // active state syncs EVERY instance of a tool (rail row + SHAPES box)
      root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('mk-active', b.dataset.tool === t));
      if (btn) { btn.classList.add('mk-active'); pop(btn); }
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
      // bin = INSTANT delete (no confirm dialog — requested): one click
      // empties the page, and the snapshot behind pushHistory IS the undo.
      if (anns.length) {
        pushHistory();
        selectedId = null;
        doc = M.clearAnnotations(doc);
        anns = doc.annotations;
        saveDoc(); syncShapePicker(); render();
        flash('Cleared ✓');
      }
      return;
    }
    if (t === 'save') {
      saveDoc().then(() => flash('Saved ✓')).catch(() => flash('Save failed'));
      return;
    }
    if (t === 'exit') teardown();
  }

  /* ---------------- draggable dock (the O square is the handle) ----------
     Minimized, the dock is just the O square stuck in the top-right corner.
     pointer-drag it anywhere: click (under the 5px threshold) still toggles
     minimize, a real drag MOVES the dock and the parked spot survives both
     viewport resizes (re-clamped) and exit/reopen (persisted). */
  function clampDockOffset(x, y) {
    const d = root && root.querySelector('#mk-dock');
    if (!d) return { x, y };
    const r = d.getBoundingClientRect(); // current rect, transform INCLUDED
    const baseX = r.left - dockOffset.x; // base corner, transform stripped
    const baseY = r.top - dockOffset.y;
    // keep the whole dock inside the viewport (4px sliver minimum on every
    // edge — the launcher must never become unreachable)
    const minX = 4 - baseX;
    const maxX = window.innerWidth - r.width - 4 - baseX;
    const minY = 4 - baseY;
    const maxY = window.innerHeight - r.height - 4 - baseY;
    return {
      x: Math.round(Math.min(Math.max(x, minX), Math.max(minX, maxX))),
      y: Math.round(Math.min(Math.max(y, minY), Math.max(minY, maxY)))
    };
  }

  function applyDockPos() {
    const d = root && root.querySelector('#mk-dock');
    if (d) d.style.transform = 'translate(' + dockOffset.x + 'px,' + dockOffset.y + 'px)';
  }

  function saveDockPos() {
    try { chrome.storage.local.set({ orbi_markup_dock: { x: dockOffset.x, y: dockOffset.y } }); }
    catch (_) { /* storage unavailable — the corner default is fine */ }
  }

  async function loadDockPos() {
    try {
      const got = await chrome.storage.local.get('orbi_markup_dock');
      const p = got && got.orbi_markup_dock;
      if (p && typeof p.x === 'number' && typeof p.y === 'number') {
        dockOffset = clampDockOffset(p.x, p.y); // viewport may have changed
        applyDockPos();
      }
    } catch (_) { /* storage unavailable — the corner default is fine */ }
  }

  /* ---------------- overlay chrome theme (light/dark) ----------------
     UI-only preference for the OVERLAY chrome — like the popup's theme, it
     lives in storage and follows the user across pages. The canvas ink,
     selection chrome and saved marks are user data and NEVER change. */
  function onThemeChanged(ch, areaName) {
    if (areaName !== 'local' || !ch.orbi_markup_theme) return;
    const t = ch.orbi_markup_theme.newValue;
    if (t === 'light' || t === 'dark') { uiTheme = t; if (syncThemeBtn) syncThemeBtn(); }
  }

  async function loadUiTheme() {
    try {
      const got = await chrome.storage.local.get('orbi_markup_theme');
      const t = got && got.orbi_markup_theme;
      if (t === 'light' || t === 'dark') uiTheme = t;
    } catch (_) { /* storage unavailable — dark default is fine */ }
    if (syncThemeBtn) syncThemeBtn(); // may arrive after build() painted the default
  }

  /* ---------------- canvas sizing + rendering ---------------- */
  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (syncOpenEditor) syncOpenEditor(); // an open note editor tracks its note
    if (dockOffset.x || dockOffset.y) { // a parked dock re-clamps to the new viewport
      dockOffset = clampDockOffset(dockOffset.x, dockOffset.y);
      applyDockPos();
    }
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
    ctx.lineWidth = a.type === 'highlight' ? 18 : (a.width || 2.5);
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
    } else if (a.type === 'triangle') {
      const x = Math.min(a.rect.x, a.rect.x + a.rect.w);
      const y = Math.min(a.rect.y, a.rect.y + a.rect.h);
      const w = Math.abs(a.rect.w) || 1, h = Math.abs(a.rect.h) || 1;
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      ctx.stroke();
    } else if (a.type === 'star') {
      const cx = a.rect.x + a.rect.w / 2, cy = a.rect.y + a.rect.h / 2;
      const R = Math.abs(a.rect.w / 2) || 1, r2 = Math.abs(a.rect.h / 2) || 1;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 === 0 ? R : r2 * 0.55;
        if (i) ctx.lineTo(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
        else ctx.moveTo(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
      }
      ctx.closePath();
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
      ctx.globalAlpha = ghost ? 0.55 : 1;
      ctx.font = fontStyle(a);
      ctx.fillStyle = a.textColor || a.color;
      // soft readability glow — just enough to lift text off busy photos,
      // not the hazy halo a heavier shadow produced
      ctx.shadowColor = 'rgba(255,255,255,0.75)';
      ctx.shadowBlur = 3;
      if (a.type === 'text') {
        // TEXT NOTE — the box IS the text: it wraps at the rect width and
        // every line is laid out INSIDE the fitted rect (see fitTextNotes),
        // so outline, hit-test, move and eraser all match what you see.
        const w = a.rect.w > 0 ? a.rect.w : 260;
        const m = textBlockMetrics(a);
        // align anchors the block INSIDE the box: center = box middle,
        // right = box right edge (before, center hung half outside left)
        const tx = a.align === 'center' ? a.rect.x + w / 2 : a.rect.x;
        const baseY = a.valign === 'middle'
          ? a.rect.y + Math.max(TEXT_PAD, (a.rect.h - m.blockH) / 2) + m.A
          : a.valign === 'bottom'
            ? a.rect.y + a.rect.h - TEXT_PAD - m.D - (m.n - 1) * m.gap
            : a.rect.y + TEXT_PAD + m.A;
        wrapText(a.text, tx, baseY, w, TEXT_LH, a.align || 'left', a.underline, a.leading);
        ctx.restore();
        return;
      }
      let tx = a.rect.x, ty = a.rect.y;
      if (a.type === 'arrow') { tx = a.rect.x + a.rect.w + 6; ty = a.rect.y + a.rect.h + 6; }
      else if (a.type === 'highlight') { ty = a.rect.y + a.rect.h + 16; }
      else { tx += 6; ty += Math.max(14, a.rect.h / 2 + 5); }
      wrapText(a.text, tx, ty, 260, TEXT_LH, a.align || 'left', a.underline, a.leading);
    }
    ctx.restore();
  }

  /* ---------------- sticky note rendering ---------------- */
  function stickyInk(hex) {
    // first 6 digits only — an 8-digit (#rrggbbaa) palette pick must not
    // shift the alpha byte into the luminance math
    const n = parseInt(hex.slice(1, 7), 16);
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
    ctx.font = fontStyle(a);
    // vertical align moves the wrapped block; default keeps the top look
    const gap = 16 * (a.leading || 1);
    const blockH = wrapCount(a.text, w - 18) * gap;
    const baseY = a.valign === 'middle'
      ? y + (h - blockH) / 2 + 11
      : a.valign === 'bottom'
        ? y + h - blockH + 11
        : y + 22;
    wrapText(a.text, x + w / 2, baseY, w - 18, 16, 'center', a.underline, a.leading);
    ctx.restore();
  }

  /* ------------- selection chrome: outline + sticky SE resize handle ------- */
  function seHandleRect(a) {
    const r = a.rect;
    return { x: Math.max(r.x, r.x + r.w) - 4, y: Math.max(r.y, r.y + r.h) - 4, w: 8, h: 8 };
  }

  // Sticky cards AND text notes resize from the SE handle: a text note's
  // box grows with its content, and a user-taller box is exactly what
  // vertical alignment needs to position the block inside the note.
  const isResizable = (a) => !!a && (a.type === 'sticky' || a.type === 'text');

  function drawSelectionChrome(a) {
    ctx.save();
    // accent blue, tuned for canvas chrome: Google blue #2563EB reads on
    // both light and dark page content (the old neon green washed out on
    // white pages) while staying unmistakably Orbitabs.
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    const r = a.type === 'pen' ? penBounds(a) : a.rect;
    ctx.strokeRect(Math.min(r.x, r.x + r.w) - 5, Math.min(r.y, r.y + r.h) - 5,
      Math.abs(r.w) + 10, Math.abs(r.h) + 10);
    ctx.setLineDash([]);
    if (isResizable(a)) {
      const h = seHandleRect(a);
      ctx.fillStyle = '#2563eb';
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(h.x, h.y, h.w, h.h, 2); else ctx.rect(h.x, h.y, h.w, h.h);
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  function wrapText(text, x, y, maxW, lh, align, underline, leading) {
    const gap = lh * (leading || 1);
    const words = String(text).split(/\s+/);
    let line = '';
    const lines = [];
    words.forEach((w) => {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
      else line = test;
    });
    if (line) lines.push(line);
    lines.forEach((ln, i) => {
      const yy = y + i * gap;
      const lw = ctx.measureText(ln).width;
      // x is the LEFT box edge for left/right, the CENTER anchor for 'center'
      const dx = align === 'center' ? -lw / 2 : align === 'right' ? maxW - lw : 0;
      ctx.fillText(ln, x + dx, yy);
      if (underline) ctx.fillRect(x + dx, yy + 2, lw, 1.2);
    });
    return lines.length * gap;
  }

  // wrapped-line count WITHOUT drawing — vertical align needs the block
  // height before the first baseline is placed
  function wrapCount(text, maxW) {
    const words = String(text).split(/\s+/);
    let line = '';
    let n = 0;
    words.forEach((w) => {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { n += 1; line = w; }
      else line = test;
    });
    if (line) n += 1;
    return n;
  }

  /* ---------------- text-note box fitting ----------------
     A text note's rect IS its box: select/move and the eraser hit-test
     RECTS (hitsMark in markup-core), so if the box doesn't contain every
     wrapped line, the lower lines can't be grabbed, moved or erased —
     exactly the "move tool doesn't move my text" bug. Measure the block
     with the SAME font/wrap metrics drawMark uses and GROW the box to fit.
     Grow-only on purpose: a user-resized box keeps its height (vertical
     align needs the slack), and history snapshots stay valid because the
     fitted annotation is a NEW object, never a mutation in place. */
  const TEXT_PAD = 4;  // breathing room between text and the box edge
  const TEXT_LH = 19;  // wrapped-line height fed to wrapText for notes

  function textBlockMetrics(a) {
    const w = a.rect.w > 0 ? a.rect.w : 260;
    ctx.save();
    ctx.font = fontStyle(a);
    const n = wrapCount(a.text, w);
    const gap = TEXT_LH * (a.leading || 1);
    const mm = ctx.measureText('Mg');
    const px = a.size || M.TEXT_SIZE_PX[a.textSize || 'M'];
    const A = Number.isFinite(mm.actualBoundingBoxAscent) ? mm.actualBoundingBoxAscent : px * 0.8;
    const D = Number.isFinite(mm.actualBoundingBoxDescent) ? mm.actualBoundingBoxDescent : px * 0.25;
    ctx.restore();
    return { n, gap, A, D, blockH: Math.max(0, n - 1) * gap + A + D };
  }

  // Immutable + idempotent: returns the SAME doc when nothing must grow,
  // so it is safe on every render/save tick and before every persist.
  function fitTextNotes(src) {
    if (!ctx || !src || !Array.isArray(src.annotations)) return src;
    let changed = false;
    const annotations = src.annotations.map((a) => {
      if (!a || a.type !== 'text' || !a.text || !a.rect) return a;
      const h = Math.max(a.rect.h, Math.round(2 * TEXT_PAD + textBlockMetrics(a).blockH));
      if (h === a.rect.h) return a;
      changed = true;
      return { ...a, rect: { ...a.rect, h } };
    });
    return changed ? { ...src, annotations } : src;
  }

  function refitTextNotes() {
    const fitted = fitTextNotes(doc);
    if (fitted !== doc) { doc = fitted; anns = doc.annotations; }
  }

  // per-mark text style — italic / weight / size / family (the size line
  // carries the pinned TEXT_SIZE_PX expression; an explicit px `size` wins)
  function fontStyle(a) {
    const px = a.size || M.TEXT_SIZE_PX[a.textSize || 'M'];
    return (a.italic ? 'italic ' : '') + (a.bold ? '700 ' : '500 ') + px + 'px ' + (a.font || MARKUP_FONT);
  }

  /* ---------------- PAGE coordinates + scroll sync ----------------
     The overlay root is position:fixed over the VIEWPORT, but annotations
     must stay glued to the WEBSITE CONTENT. Every canvas input converts
     client→page coords on the way in (toDoc); render() translates by the
     live scroll offset on the way out. So wheel / keys / touch / find-in-
     page / anchor scrolls carry the marks with the content instead of
     leaving them pinned to the viewport ("the site scrolled, the mark
     stayed" — useless when researching a long article). */
  const pgX = () => window.scrollX || window.pageXOffset || 0;
  const pgY = () => window.scrollY || window.pageYOffset || 0;
  const toDoc = (e) => ({ x: e.clientX + pgX(), y: e.clientY + pgY() });

  /* ---------------- SCROLL-CONTAINER anchors (real sites scroll DIVs) ---
     X/Twitter, Gmail, Reddit, Notion scroll an INNER container — window
     .scrollY never changes there, so the page-translate alone leaves marks
     behind ("site scrolled, mark stayed"). Each mark therefore records the
     scrollable ANCESTORS of the element it was drawn on (anchor.els) plus
     their scrollTop/scrollLeft at creation (anchor.sx/sy). anchorDelta(a)
     is how far those containers have scrolled SINCE: render() paints the
     mark shifted by −delta (in its own space), hit-testing ADDS delta so
     the pointer is tested where the mark renders, and the eraser gets the
     same per-mark offset. A container removed from the DOM (SPA nav) or a
     reloaded page simply contributes 0 → classic window-space behaviour. */
  function scrollParentsOf(el) {
    const els = [];
    let n = el;
    while (n && n.nodeType === 1) {
      // the WINDOW's own scroller is handled globally by pgX()/pgY() —
      // counting it here would double-apply the same offset
      if (n !== document.scrollingElement && n !== document.documentElement && n !== document.body) {
        let oy = '', ox = '';
        try { const cs = getComputedStyle(n); oy = cs.overflowY; ox = cs.overflowX; } catch (_) { /* detached */ }
        const scrollY = /(auto|scroll|overlay)/.test(oy) && n.scrollHeight > n.clientHeight + 1;
        const scrollX = /(auto|scroll|overlay)/.test(ox) && n.scrollWidth > n.clientWidth + 1;
        if (scrollY || scrollX) els.push(n);
      }
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null; // cross shadow boundaries
    }
    return els;
  }
  // The element under the pointer WITHOUT our own overlay intercepting the
  // query: the canvas covers the viewport, so elementFromPoint would only
  // ever return the canvas itself. Walk the full hit-stack and skip every
  // element inside the overlay root — the root is pointer-events:none, but
  // a foreign overlay (or a future CSS slip) must never be able to hijack
  // the scroll-anchor walk again (that bug froze every mark on inner-scroll
  // sites: the chain came back empty → delta always 0).
  function elementUnderPage(cx, cy) {
    const pts = document.elementsFromPoint
      ? document.elementsFromPoint(cx, cy)
      : [document.elementFromPoint(cx, cy)];
    const inOverlay = (el) => !!(root && el && (el === root || (root.contains && root.contains(el))));
    for (const el of pts) {
      if (el && el.nodeType === 1 && !inOverlay(el)) return el;
    }
    return document.body;
  }
  // Snapshot the scroller chain at GESTURE START (delta is 0 by definition)
  function captureAnchor(cx, cy) {
    const els = scrollParentsOf(elementUnderPage(cx, cy) || document.body);
    // PATH descriptors (tag + nth-of-type index + id hint, innermost-first):
    // the durable half of the anchor — storage keeps numbers + path, and the
    // overlay re-resolves live element refs from path after a reload.
    const path = els.map((n) => {
      let i = 0, sib = n;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === n.tagName) i++; }
      return { t: n.tagName, i, id: n.id || undefined };
    });
    return { els, path, sx: els.map((n) => n.scrollTop), sy: els.map((n) => n.scrollLeft) };
  }
  // Reload re-attachment: els are runtime-only, so a restored mark resolves
  // its scroller chain from the stored path. An id match is trusted; the
  // positional fallback fires only when the page's same-tag scroller census
  // still matches the recorded one. Unresolvable → [] — classic window-space
  // (safe default: NEVER binding the mark to a WRONG container).
  function resolveAnchorPath(anchor) {
    const path = anchor && anchor.path;
    if (!Array.isArray(path) || !path.length) return [];
    if (!path.every((p) => p && typeof p.t === 'string' && Number.isInteger(p.i))) return [];
    const isScroller = (n) => {
      let oy = '', ox = '';
      try { const cs = getComputedStyle(n); oy = cs.overflowY; ox = cs.overflowX; } catch (_) { return false; }
      return (/(auto|scroll|overlay)/.test(oy) && n.scrollHeight > n.clientHeight + 1) ||
             (/(auto|scroll|overlay)/.test(ox) && n.scrollWidth > n.clientWidth + 1);
    };
    const perTag = {};
    path.forEach((p) => { perTag[p.t] = (perTag[p.t] || 0) + 1; });
    const used = new Set();
    const els = [];
    for (const p of path) {
      let el = null;
      if (p.id) {
        const cand = document.getElementById(p.id);
        if (cand && cand.tagName === p.t && !used.has(cand) && isScroller(cand)) el = cand;
      }
      if (!el) {
        const pool = Array.from(document.querySelectorAll(p.t)).filter((n) => !used.has(n) && isScroller(n));
        if (pool.length === perTag[p.t]) el = pool[p.i] || null;
      }
      if (!el) return [];
      used.add(el);
      els.push(el);
    }
    return els;
  }
  function reattachAnchors() {
    anns.forEach((a) => {
      if (a && a.anchor && !Array.isArray(a.anchor.els)) a.anchor.els = resolveAnchorPath(a.anchor);
    });
  }
  // How far the mark's own containers have scrolled since the snapshot
  const anchorDelta = (a) => {
    const an = a && a.anchor;
    if (!an || !Array.isArray(an.els)) return { dx: 0, dy: 0 };
    let dx = 0, dy = 0;
    for (let i = 0; i < an.els.length; i++) {
      const el = an.els[i];
      if (!el || !el.isConnected) continue; // container gone → no shift
      dx += el.scrollLeft - (an.sy[i] || 0);
      dy += el.scrollTop - (an.sx[i] || 0);
    }
    return { dx, dy };
  };
  // pointer (client) + window scroll + container delta → a given mark's own
  // coordinate space (its stored rect/points live there)
  const toMarkSpace = (cx, cy, a) => {
    const d = anchorDelta(a);
    return { x: cx + pgX() + d.dx, y: cy + pgY() + d.dy };
  };
  let syncOpenEditor = null; // place() of the live note editor — re-run on scroll
  let scrollRaf = 0;
  function onScroll() {
    if (syncOpenEditor) syncOpenEditor(); // an open editor tracks its note
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; render(); });
  }
  /* Touch: pointerdown fires BEFORE touchstart, so by the time the browser
     decides whether this touch may pan the page, the gesture is already
     flagged as ours (drawing / moving / resizing / erasing). Cancel the
     default action ONLY in that case — a touch-drag then moves the note or
     draws ink instead of scrolling the website underneath it, while an
     empty-canvas touch still scrolls the article as usual. */
  const ownsGesture = () => !!(drawing || drag || sizing || erasing);
  const stopTouchPan = (e) => { if (ownsGesture()) e.preventDefault(); };
  /* Gesture interrupted (device rotation, palm rejection, system dialog):
     committed work stays via saveDoc; the in-flight stroke is dropped. */
  function onCancel() {
    if (sizing) { sizing = null; saveDoc(); render(); return; }
    if (drag) { drag = null; saveDoc(); render(); return; }
    if (erasing) { erasing = false; saveDoc(); render(); return; }
    if (drawing) { drawing = null; render(); }
  }

  // Draw one mark in ITS anchor space: containers that scrolled since the
  // mark was created shift it by −delta, so it rides the content instead
  // of the viewport (delta 0 → straight draw, no extra save/restore).
  function drawInMarkSpace(a, fn) {
    const d = anchorDelta(a);
    if (!d.dx && !d.dy) { fn(); return; }
    ctx.save();
    ctx.translate(-d.dx, -d.dy);
    fn();
    ctx.restore();
  }

  function render() {
    if (!ctx) return;
    refitTextNotes(); // the box must contain the wrapped lines before we draw/hit it
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    // canvas pixel = PAGE coord − scroll offset (viewport space)
    ctx.translate(-pgX(), -pgY());
    // each mark paints in ITS anchor space: containers that scrolled since
    // the mark was drawn shift it by −delta, so it rides the content
    anns.forEach((a) => drawInMarkSpace(a, () => drawMark(a, false)));
    if (drawing) drawInMarkSpace(drawing, () => drawMark(drawing, true));
    const sel = anns.find((a) => a.id === selectedId);
    if (sel) drawInMarkSpace(sel, () => drawSelectionChrome(sel));
    ctx.restore();
    syncShapePicker(); // erasing/deselecting must never leave a stale picker
    syncTextControls();
  }

  // sanitize kept the anchor's NUMERIC snapshot; the live container refs
  // (els) ride along in memory only — re-attached after every commit so the
  // mark keeps tracking its scroller (undo snapshots carry them too).
  function reanchorLast(raw) {
    const last = anns[anns.length - 1];
    if (last && raw && raw.anchor && Array.isArray(raw.anchor.els)) last.anchor = raw.anchor;
  }

  /* ---------------- storage ---------------- */
  async function loadDoc() {
    try {
      const got = await chrome.storage.local.get('orbi_annotations');
      const store = got.orbi_annotations || {};
      const existing = store[M.normalizeUrlKey(url)];
      doc = existing && Array.isArray(existing.annotations) ? existing : M.emptyDoc(url);
    } catch (_) { doc = M.emptyDoc(url); }
    const pre = doc;
    anns = doc.annotations;
    reattachAnchors(); // stored path → live scroller refs (F5 keeps anchoring)
    refitTextNotes(); // notes saved before box-fitting stored a fixed 24px box
    if (doc !== pre) saveDoc(); // persist the grown boxes once
    render();
  }

  async function saveDoc() {
    refitTextNotes(); // persist fitted boxes — legacy 24px-tall notes migrate here
    try {
      const got = await chrome.storage.local.get('orbi_annotations');
      const store = got.orbi_annotations || {};
      doc.url = url;
      doc.urlKey = M.normalizeUrlKey(url);
      // element refs can't be structured-cloned into storage — persist only
      // the numeric snapshot + the PATH descriptors; reattachAnchors()
      // re-resolves live refs from path after a reload, so container
      // anchoring survives F5 instead of degrading to window-space
      const safe = doc.annotations.map((a) => (a && a.anchor && Array.isArray(a.anchor.els))
        ? { ...a, anchor: { sx: a.anchor.sx, sy: a.anchor.sy, path: a.anchor.path } } : a);
      store[doc.urlKey] = { ...doc, annotations: safe };
      await chrome.storage.local.set({ orbi_annotations: store });
    } catch (_) { /* storage full/unavailable — marks stay visible until exit */ }
  }

  /* ---------------- hit testing (select/move) ----------------
     Same geometry as the eraser — hitsMark in markup-core (pen strokes
     point-by-point, others by rect ± 6px pick slop) — wrapped so SELECT
     returns the topmost hit and never races the eraser's semantics. */
  const PICK_SLOP = 6;
  // CLIENT coords in, each mark tested in ITS OWN space (pointer + window
  // scroll + that mark's container delta) so a note inside a scrolled div
  // is pickable exactly where it renders. Returns { a, x, y } — x/y are the
  // click expressed in the hit mark's space (the drag's frame of reference).
  function hitTest(cx, cy) {
    for (let i = anns.length - 1; i >= 0; i--) {
      const a = anns[i];
      const s = toMarkSpace(cx, cy, a);
      if (M.hitsMark(a, s.x, s.y, PICK_SLOP)) return { a, x: s.x, y: s.y };
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
    const { x, y } = toDoc(e); // PAGE coords — marks stay anchored to content
    if (tool === 'eraser') {
      // one history entry per erase STROKE (all its removals undo together)
      pushHistory();
      erasing = true;
      const { doc: after, removed } = M.eraseAt(doc, x, y, M.ERASER.RADIUS, anchorDelta);
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
      // SE handle of a selected sticky/text note starts a RESIZE — checked
      // BEFORE the hit-test so the handle wins over the body under it
      const hs = sel ? toMarkSpace(e.clientX, e.clientY, sel) : null;
      if (isResizable(sel) && hs && inRect(hs.x, hs.y, seHandleRect(sel))) {
        sizing = { id: sel.id, last: { x: hs.x, y: hs.y } };
        pushHistory(); // resize is one reversible action
        try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* pointer already released */ }
        return;
      }
      const hit = hitTest(e.clientX, e.clientY);
      selectedId = hit ? hit.a.id : null;
      // drag tracks the START point — the total offset is rounded ONCE, so
      // long drags end exactly under the cursor (per-move rounding drifted)
      if (hit) { drag = { id: hit.a.id, x0: hit.x, y0: hit.y, ax: 0, ay: 0 }; pushHistory(); // move is one reversible action
        // capture: the drag keeps flowing even when the pointer crosses the dock
        try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic/ended pointer */ }
      }
      syncShapePicker();
      render();
      return;
    }
    if (drag || sizing) return; // a captured drag/resize is still in flight — don't start drawing
    drawing = {
      id: M.genId(),
      type: tool,
      anchor: captureAnchor(e.clientX, e.clientY), // scrollers this stroke rides on
      color,
      textColor: inkColor || undefined,
      textSize,
      width: tool === 'pen' ? penWidth : undefined,
      font: textStyle.font || undefined,
      size: textStyle.size || undefined,
      align: textStyle.align || undefined,
      valign: textStyle.valign || undefined,
      bold: textStyle.bold || undefined,
      italic: textStyle.italic || undefined,
      underline: textStyle.underline || undefined,
      leading: textStyle.leading || undefined,
      rect: { x, y, w: 0, h: 0 },
      points: tool === 'pen' ? [[x, y]] : undefined,
      text: tool === 'text' ? '' : undefined,
      createdAt: new Date().toISOString()
    };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* pointer already released */ }
  }

  function onMove(e) {
    const { x, y } = toDoc(e); // WINDOW coords — the eraser's shared base
    if (sizing) {
      const sel = anns.find((a) => a.id === sizing.id);
      if (sel) {
        // resize in the note's OWN space (its containers may scroll)
        const s = toMarkSpace(e.clientX, e.clientY, sel);
        const { doc: resized } = M.resizeAnnotation(doc, sizing.id, s.x - sizing.last.x, s.y - sizing.last.y);
        doc = resized; anns = doc.annotations;
        sizing.last = { x: s.x, y: s.y };
      }
      render();
      return;
    }
    if (drag) {
      const a = anns.find((n) => n.id === drag.id);
      const s = a ? toMarkSpace(e.clientX, e.clientY, a) : { x, y };
      const ndx = Math.round(s.x - drag.x0), ndy = Math.round(s.y - drag.y0);
      if (ndx !== drag.ax || ndy !== drag.ay) {
        const { doc: moved } = M.moveAnnotation(doc, drag.id, ndx - drag.ax, ndy - drag.ay);
        doc = moved; anns = doc.annotations;
        drag.ax = ndx; drag.ay = ndy;
      }
      render();
      return;
    }
    // ERASER: drag across the page — every mark the cursor touches goes
    // (eraseAt converts the nib into EACH mark's anchor space itself)
    if (tool === 'eraser' && erasing) {
      const { doc: after, removed } = M.eraseAt(doc, x, y, M.ERASER.RADIUS, anchorDelta);
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
      const hs = sel ? toMarkSpace(e.clientX, e.clientY, sel) : null;
      canvas.style.cursor = isResizable(sel) && hs && inRect(hs.x, hs.y, seHandleRect(sel)) ? 'nwse-resize'
        : hitTest(e.clientX, e.clientY) ? 'move' : 'default';
      return;
    }
    if (!drawing) return;
    // ink lands in the STROKE's own anchor space — a container scroll
    // mid-stroke shifts the ghost AND the committed mark with the content
    const s = toMarkSpace(e.clientX, e.clientY, drawing);
    if (tool === 'pen') drawing.points.push([s.x, s.y]);
    else {
      drawing.rect.w = s.x - drawing.rect.x;
      drawing.rect.h = s.y - drawing.rect.y;
    }
    render();
  }

  function onUp(e) {
    if (sizing) { sizing = null; saveDoc(); return; } // resize finished → persist
    if (drag) { drag = null; saveDoc(); return; } // move finished → persist
    if (erasing) { erasing = false; saveDoc(); return; } // erase stroke done → persist
    if (!drawing) return;
    const d = drawing; drawing = null;
    // commit coords in the STROKE's own space (its containers may have
    // scrolled mid-draw) — the mark lands exactly where the ink is
    const { x, y } = toMarkSpace(e.clientX, e.clientY, d);

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
          reanchorLast(d); // keep the live scroller refs on the new note
          // hand the fresh note to the cursor tool: it's selected + movable,
          // and its color can be changed with one palette click (request 2+3)
          selectedId = anns[anns.length - 1].id;
          setTool('select');
        }
        saveDoc();
        render();
      }, { anchor: d.anchor }); // the editor tracks the note's containers
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
            reanchorLast(d); // sticky rides its container too
            selectedId = anns[anns.length - 1].id; // selected → resize/recolor ready
            setTool('select');
          }
          saveDoc(); render();
        }, { placeholder: 'Type inside the note… (Enter to save)', anchor: d.anchor });
      return;
    }

    pushHistory(); // shape creation is one reversible action
    const { doc: added } = M.addAnnotation(doc, d);
    doc = added; anns = doc.annotations;
    reanchorLast(d); // the shape keeps its scroller refs after sanitizing
    const id = anns[anns.length - 1].id;

    // Shape label — optional, offered right after drawing; blur commits it
    openTextArea(x, y, (val) => {
      if (val) {
        pushHistory(); // label add is one reversible action
        doc = M.setAnnotationText(doc, id, val).doc;
        anns = doc.annotations;
      }
      saveDoc(); render();
    }, { atShape: d, anchor: d.anchor });
    saveDoc(); render();
  }

  // Double-click an existing mark: sticky/text → edit the body, shapes → label
  function onDblClick(e) {
    if (tool !== 'select' || e.target !== canvas) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;
    const a = hit.a, x = hit.x, y = hit.y; // the mark + the click IN ITS SPACE
    const isBody = a.type === 'sticky' || a.type === 'text';
    openTextArea(x, y, (val) => {
      if (val !== (a.text || '')) {
        pushHistory(); // body/label edit is one reversible action
        doc = M.setAnnotationText(doc, a.id, val).doc;
        anns = doc.annotations;
      }
      saveDoc(); render();
    }, {
      initial: a.text || '',
      editId: a.id, // ink clicks now LIVE-recolor this mark while typing
      anchor: a.anchor, // the box tracks THIS note's containers on scroll
      placeholder: isBody ? 'Edit the note… (Enter to save)' : 'Label… (Enter to save; empty clears)'
    });
  }

  function setTool(t) {
    const b = root && root.querySelector('[data-tool="' + t + '"]');
    if (b) onTool(t, b);
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
    const anch = opts.anchor || null; // the note's scroller chain (may be absent)
    const isArrow = opts.atShape && opts.atShape.type === 'arrow';
    const isTextTool = opts.atShape && opts.atShape.type === 'text';
    // x/y and at.rect are PAGE coords; the box is placed in VIEWPORT space by
    // subtracting the LIVE scroll offset — and re-placed on every scroll so an
    // open editor stays glued to its note while the article moves.
    const ax = isArrow ? at.rect.x + at.rect.w + 6 : at.rect.x + 6;
    const ay = !isArrow && !isTextTool
      ? at.rect.y + Math.max(0, at.rect.h / 2 - 14)
      : y - 10;
    const placeInput = () => {
      // PAGE → viewport, minus the note's OWN container delta — and re-placed
      // on every scroll event so an open editor stays glued while content moves
      const td = anchorDelta(anch);
      input.style.left = Math.max(4, ax - pgX() - td.dx) + 'px';
      input.style.top = Math.max(4, ay - pgY() - td.dy) + 'px';
      // Wider box (280px) — clamp the LEFT edge after layout so the box can
      // never overflow the right side of the viewport no matter where it opens.
      const boxW = input.offsetWidth || 280;
      const maxLeft = Math.max(4, window.innerWidth - boxW - 8);
      const curLeft = parseFloat(input.style.left) || 4;
      if (curLeft > maxLeft) input.style.left = Math.round(maxLeft) + 'px';
    };
    if (opts.initial) input.value = opts.initial;

    const finish = (save) => {
      if (done) return;
      done = true;                 // Enter, blur or Esc — exactly ONE finish
      const ctx = activeTextCtx;
      activeTextCtx = null;
      const val = input.value.trim();
      input.remove();
      syncOpenEditor = null;       // no editor left to re-place on scroll
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
    placeInput();                // PAGE → viewport (live scroll offset subtracted)
    syncOpenEditor = placeInput; // scroll handler re-places it while it is open
    input.focus();
  }

  function flash(msg) {
    const s = root && root.querySelector('.mk-status');
    if (!s) return;
    s.textContent = msg;
    // re-trigger the slide-up even when two flashes fire back-to-back
    s.classList.remove('mk-flash');
    void s.offsetWidth;
    s.classList.add('mk-flash');
    setTimeout(() => { s.textContent = ''; s.classList.remove('mk-flash'); }, 1600);
  }

  // Soft confirm-pop for overlay controls (same motion language as the
  // popup): a re-triggerable one-cycle scale bounce on the clicked control.
  // animationend cleans the class up; under prefers-reduced-motion the
  // animation never runs, the class just lingers harmlessly (CSS sets none).
  function pop(el) {
    if (!el || !el.classList) return;
    el.classList.remove('mk-pop');
    void el.offsetWidth; // force restart so back-to-back picks both bounce
    el.classList.add('mk-pop');
    el.addEventListener('animationend', () => el.classList.remove('mk-pop'), { once: true });
  }

  function teardown() {
    saveDoc();
    if (root) root.remove();
    root = canvas = ctx = null;
    undoStack = []; redoStack = [];
    window.removeEventListener('resize', resize);
    window.removeEventListener('scroll', onScroll, true);
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    syncOpenEditor = null; // the editor element is gone with the root
    if (chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.removeListener) {
      try { chrome.storage.onChanged.removeListener(onThemeChanged); } catch (_) { /* already removed */ }
    }
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
