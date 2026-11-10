// 🖊 ORBITABS MARKUP — CORE (pure logic, zero DOM / zero chrome.*)
// ------------------------------------------------------------------
// The annotation engine behind the Markup overlay. Data-not-pixels:
// every mark is a structured record (see docs/MARKUP_SPEC.md §2) keyed by
// page URL, so annotations stay editable, undoable, and restorable
// with the session — and the original website is NEVER modified.
//
// Classic script (no imports) so it can run in the extension page,
// in a content script, and in Node test harnesses alike:
//   const M = globalThis.OrbitabsMarkup
//
// Storage shape (chrome.storage.local key `orbi_annotations`):
//   { [urlKey]: { url, urlKey, annotations: Annotation[] } }
//
// Annotation (v1):
//   { id, type: pen|highlight|rect|circle|arrow|text|sticky,
//     color, textColor, rect: {x,y,w,h},  // viewport CSS px at draw time
//     points: [[x,y],...],                // pen strokes only
//     text, shape,                        // body/label + sticky card shape
//     createdAt }
(function (root) {
  'use strict';

  const TOOLS = ['pen', 'highlight', 'rect', 'circle', 'arrow', 'text', 'sticky', 'triangle', 'star'];
  // Compact fill palette: yellow red green blue black white (+ the 🎨 picker
  // in the UI covers everything else). Storage keeps ANY valid hex, so older
  // marks with retired colors still render.
  const COLORS = ['#facc15', '#ef4444', '#22c55e', '#3b82f6', '#111827', '#f8fafc'];
  // Ink palette — TEXT color, compact: auto + these 5.
  const INK_COLORS = ['#111827', '#f8fafc', '#ef4444', '#3b82f6', '#22c55e'];
  const MAX_PER_URL = 200;      // per-page cap — oldest marks fall off first
  const MAX_TEXT_LEN = 500;
  const MIN_W = 20;             // resize floor — a mark can never collapse to nothing
  const MIN_H = 14;
  const SHAPES = ['rect', 'circle']; // sticky-note card shapes
  // Text sizes for notes/labels: S 12px · M 15px · L 18px (M = default)
  const TEXT_SIZES = ['S', 'M', 'L'];
  const TEXT_SIZE_PX = { S: 12, M: 15, L: 18 };
  const ERASER = { RADIUS: 14 }; // eraser hit radius (px) around the cursor
  const STRIP_PARAMS = [        // tracking params that break URL identity
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'gclid', 'fbclid', 'ref', 'ref_src'
  ];

  /** Canonical page key: same article with/without #section or utm junk
   *  must map to the SAME annotations. Scheme+host+path+clean query. */
  function normalizeUrlKey(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return '';
    try {
      const u = new URL(raw);
      u.hash = '';
      STRIP_PARAMS.forEach((p) => u.searchParams.delete(p));
      const q = u.searchParams.toString();
      return u.origin + u.pathname + (q ? '?' + q : '');
    } catch {
      return raw.split('#')[0]; // relative or odd input — best effort
    }
  }

  // 6-digit hex, or 8-digit (#rrggbbaa) — the custom palette can set opacity
  const isHexColor = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c);
  const isFontName = (f) => typeof f === 'string' && f.length > 0 && f.length <= 40 && /^[\w ,'-]+$/.test(f);
  const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /** Shared hit geometry: does the point (x, y) lie within radius R of a
   *  mark? Pen strokes count point-by-point; every other mark by its rect.
   *  One implementation serves the ERASER (remove what is hit) and the
   *  overlay's SELECT hit-testing (pick the topmost mark hit). */
  function hitsMark(a, x, y, R) {
    if (a.type === 'pen' && Array.isArray(a.points)) {
      return a.points.some(([px, py]) => Math.abs(px - x) <= R && Math.abs(py - y) <= R);
    }
    const rr = a.rect || {};
    const x1 = Math.min(rr.x ?? 0, (rr.x ?? 0) + (rr.w ?? 0)) - R;
    const x2 = Math.max(rr.x ?? 0, (rr.x ?? 0) + (rr.w ?? 0)) + R;
    const y1 = Math.min(rr.y ?? 0, (rr.y ?? 0) + (rr.h ?? 0)) - R;
    const y2 = Math.max(rr.y ?? 0, (rr.y ?? 0) + (rr.h ?? 0)) + R;
    return x >= x1 && x <= x2 && y >= y1 && y <= y2;
  }

  /** Validate + clean ONE annotation from untrusted data. Returns null for
   *  garbage — callers skip, never crash (same rule as the session schema). */
  function sanitizeAnnotation(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!TOOLS.includes(raw.type)) return null;

  const r = raw.rect || {};
  if (!isNum(r.x) || !isNum(r.y)) return null;
  const rect = {
    x: clamp(Math.round(r.x), -1e6, 1e6),
    y: clamp(Math.round(r.y), -1e6, 1e6),
    w: isNum(r.w) ? clamp(Math.round(r.w), -1e6, 1e6) : 0,
    h: isNum(r.h) ? clamp(Math.round(r.h), -1e6, 1e6) : 0
  };
  // An ARROW's w/h are SIGNED — the sign IS its direction (an up-left drag
  // points the arrow up-left). Every other mark normalizes to a positive
  // box: which way you dragged must not change a shape's size, and the
  // resize floor (MIN_W/MIN_H) assumes w/h ≥ 0.
  if (raw.type !== 'arrow') {
    if (rect.w < 0) { rect.x += rect.w; rect.w = -rect.w; }
    if (rect.h < 0) { rect.y += rect.h; rect.h = -rect.h; }
    rect.x = clamp(rect.x, -1e6, 1e6);
    rect.y = clamp(rect.y, -1e6, 1e6);
  }

    let points = null;
    if (raw.type === 'pen') {
      if (!Array.isArray(raw.points) || raw.points.length < 2) return null;
      points = raw.points
        .filter((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1]))
        .slice(0, 5000)
        .map((p) => [Math.round(p[0]), Math.round(p[1])]);
      if (points.length < 2) return null;
    }

    // sticky notes carry a card shape (rect | circle); the circle TOOL is
    // always a circle; other marks have no shape field at all
    let shape = null;
    if (raw.type === 'sticky') shape = SHAPES.includes(raw.shape) ? raw.shape : 'rect';
    else if (raw.type === 'circle') shape = 'circle';

  // text AND sticky tools: body text (required — a blank note is nothing);
  // other tools: OPTIONAL label ("STOP HERE" on a rectangle, a name inside
  // a circle…). Empty label → null.
  const t = String(raw.text == null ? '' : raw.text).slice(0, MAX_TEXT_LEN).trim();
  if ((raw.type === 'text' || raw.type === 'sticky') && !t) return null;
  const text = t || null;

    const out = {
      id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : genId(),
      type: raw.type,
      color: isHexColor(raw.color) ? raw.color : COLORS[0],
      rect,
      points,
      text,
      // textColor = explicit ink override (null = auto-contrast on stickies,
      // the mark color on labels). Garbage in → null, never a crash.
      textColor: isHexColor(raw.textColor) ? raw.textColor : null,
      textSize: TEXT_SIZES.includes(raw.textSize) ? raw.textSize : 'M',
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString()
    };
    // v2 style fields (TEXT box / PEN TOOL box) — kept only when valid,
    // omitted otherwise so old marks and garbage stay clean
    if (isNum(raw.width) && raw.width >= 1 && raw.width <= 48) out.width = Math.round(raw.width);
    if (isFontName(raw.font)) out.font = raw.font;
    if (['left', 'center', 'right'].includes(raw.align)) out.align = raw.align;
    if (raw.bold === true) out.bold = true;
    if (raw.italic === true) out.italic = true;
    if (raw.underline === true) out.underline = true;
    if (['top', 'middle', 'bottom'].includes(raw.valign)) out.valign = raw.valign;
    if (isNum(raw.size) && raw.size >= 6 && raw.size <= 72) out.size = Math.round(raw.size);
    if (isNum(raw.leading) && raw.leading >= 1 && raw.leading <= 3) out.leading = Math.round(raw.leading * 100) / 100;
    if (shape) out.shape = shape;
    // SCROLL-ANCHOR: which scrollable ancestors this mark was drawn inside
    // (+ their scroll offsets at creation — overlay captureAnchor). Only the
    // NUMERIC snapshot is trusted from storage; live element refs (`els`) are
    // runtime-only, re-attached by the overlay after every commit.
    const cleanScrollArr = (arr) => Array.isArray(arr) && arr.length <= 8 && arr.every(isNum);
    if (raw.anchor && typeof raw.anchor === 'object' &&
        cleanScrollArr(raw.anchor.sx) && cleanScrollArr(raw.anchor.sy) &&
        raw.anchor.sx.length === raw.anchor.sy.length) {
      out.anchor = { sx: raw.anchor.sx.map((v) => Math.round(v)),
                     sy: raw.anchor.sy.map((v) => Math.round(v)) };
      // Persistent PATH descriptors (tag + nth-of-type index + optional id
      // hint, innermost-first like sx/sy): the overlay re-resolves the
      // scroller chain from these after a reload — container anchoring
      // survives F5, not just live scrolling. Runtime `els` element refs
      // can never be stored; path is the durable half of the anchor.
      const cleanPath = (arr) => Array.isArray(arr) && arr.length > 0 && arr.length <= 8 &&
        arr.every((e) => e && typeof e.t === 'string' && /^[A-Z][A-Z0-9-]*$/.test(e.t) &&
          Number.isInteger(e.i) && e.i >= 0 && e.i < 1000);
      if (cleanPath(raw.anchor.path)) {
        out.anchor.path = raw.anchor.path.map((e) => ({
          t: e.t, i: e.i,
          id: typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 100 ? e.id : undefined
        }));
      }
    }
    return out;
  }

  let idCounter = 0;
  function genId() {
    idCounter = (idCounter + 1) % 1e6;
    return 'an_' + Date.now().toString(36) + '_' + idCounter.toString(36) +
      '_' + Math.floor(Math.random() * 1e6).toString(36);
  }

  /** Empty doc for a page. */
  function emptyDoc(rawUrl) {
    const urlKey = normalizeUrlKey(rawUrl);
    return { url: String(rawUrl || ''), urlKey, annotations: [] };
  }

  /** Add a mark (sanitized). Enforces the per-page cap by dropping the
   *  OLDEST annotation. Returns { doc, added }. Never mutates the input. */
  function addAnnotation(doc, raw) {
    const clean = sanitizeAnnotation(raw);
    if (!clean || !doc || !Array.isArray(doc.annotations)) return { doc, added: false };
    const next = { ...doc, annotations: [...doc.annotations, clean] };
    if (next.annotations.length > MAX_PER_URL) {
      next.annotations = next.annotations.slice(next.annotations.length - MAX_PER_URL);
    }
    return { doc: next, added: true };
  }

  /* ── RUB-OUT ERASER internals ────────────────────────────────────────────
     A real eraser takes only what it touches, so strokes are CLIPPED instead
     of deleted: the eraser's square (the same box hitsMark tests) is cut out
     of the polyline, surviving parts stay, and a nick in the middle splits
     the stroke into two. Liang-Barsky gives each segment's inside interval
     [t0, t1]; everything outside it is kept, with the exact crossing points
     inserted so the gap is clean at the nib's edge. */
  function clipPenRuns(points, x, y, R) {
    const bx1 = x - R, bx2 = x + R, by1 = y - R, by2 = y + R;
    const lerp = (a, b, t) => [Math.round(a[0] + (b[0] - a[0]) * t),
                               Math.round(a[1] + (b[1] - a[1]) * t)];
    // inside-interval of segment A→B, or null when the box never touches it
    const insideT = (A, B) => {
      let t0 = 0, t1 = 1;
      const dx = B[0] - A[0], dy = B[1] - A[1];
      const p = [-dx, dx, -dy, dy];
      const q = [A[0] - bx1, bx2 - A[0], A[1] - by1, by2 - A[1]];
      for (let i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return null; }
        else {
          const r = q[i] / p[i];
          if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
          else { if (r < t0) return null; if (r < t1) t1 = r; }
        }
      }
      // a zero-width interval = the line only GRAZES the rim → not an erase
      return t1 - t0 > 1e-9 ? [t0, t1] : null;
    };
    const runs = [];
    let cur = null;
    let touched = false; // did the nib actually intersect this stroke?
    for (let i = 0; i < points.length - 1; i++) {
      const A = points[i], B = points[i + 1];
      const iv = insideT(A, B);
      if (!iv) { // segment stays clear of the box — it continues the run
        if (cur) cur.push(B); else cur = [A, B];
        continue;
      }
      touched = true;
      const [s, e] = iv;
      if (s > 0) { // head of the segment lies OUTSIDE — close it as a run
        const pIn = lerp(A, B, s);
        if (cur) cur.push(pIn); else cur = [A, pIn];
        if (cur.length >= 2) runs.push(cur);
        cur = null;
      }
      if (e < 1) { // tail lies OUTSIDE — a fresh run starts at the exit
        const pOut = lerp(A, B, e);
        cur = [pOut];
        if (pOut[0] !== B[0] || pOut[1] !== B[1]) cur.push(B);
      } else {
        cur = null; // the rest of this segment is inside (or exits at B)
      }
    }
    if (cur && cur.length >= 2) runs.push(cur);
    return { touched, runs: runs.filter((r) => r.length >= 2) };
  }

  /** Highlight rub-out: bands are rectangles, so the round nib becomes a
   *  straight GAP cut across the band's LONG axis (the same approximation
   *  every marker-eraser uses). Returns the surviving pieces, or null when a
   *  cut would leave dust stubs / spans the whole band — the caller then
   *  deletes the band outright. */
  function cutHighlight(rect, x, y, R) {
    const x1 = Math.min(rect.x, rect.x + rect.w), x2 = Math.max(rect.x, rect.x + rect.w);
    const y1 = Math.min(rect.y, rect.y + rect.h), y2 = Math.max(rect.y, rect.y + rect.h);
    const horiz = x2 - x1 >= y2 - y1;
    const lo0 = horiz ? x1 : y1, hi0 = horiz ? x2 : y2;
    const lo = (horiz ? x : y) - R, hi = (horiz ? x : y) + R;
    if (lo <= lo0 && hi >= hi0) return null; // nib spans the band → whole delete
    const GAP = 2, MIN = 6; // clean margin around the cut · no dust pieces
    const pieces = [];
    const push = (from, to) => {
      if (to - from < MIN) return;
      pieces.push(horiz
        ? { x: from, y: y1, w: to - from, h: y2 - y1 }
        : { x: x1, y: from, w: x2 - x1, h: to - from });
    };
    push(lo0, Math.min(hi0, lo - GAP));
    push(Math.max(lo0, hi + GAP), hi0);
    return pieces.length ? pieces : null;
  }

  /** Eraser: RUB-OUT semantics — only what the nib touches goes.
   *  · pen strokes are clipped against the eraser box: untouched parts
   *    survive, a middle nick SPLITS the stroke in two, a rubbed end just
   *    shortens it (the stroke is never deleted whole).
   *  · highlight bands get a gap cut along their long axis.
   *  · every other mark is one solid object — contact removes it entirely.
   *  Returns { doc, removed } — removed[] carries EVERY annotation the eraser
   *  took (the original stroke/band even when a piece survives), so callers
   *  can restore verbatim. Immutable.
   *
   *  `offsetOf(a)` (optional) returns {dx,dy} — how far THIS mark's own
   *  scroll containers have moved since it was drawn. The nib point is
   *  converted into each mark's space before testing, so a note inside a
   *  scrolled div is erased exactly where it renders (overlay anchorDelta).
   *  No offsetOf → classic shared-space behaviour. */
  function eraseAt(doc, x, y, radius, offsetOf) {
    if (!doc || !Array.isArray(doc.annotations)) return { doc, removed: [] };
    if (!isNum(x) || !isNum(y)) return { doc, removed: [] };
    const R = isNum(radius) && radius > 0 ? radius : ERASER.RADIUS;
    const removed = [];
    let annotations = [];
    doc.annotations.forEach((a) => {
      if (!a) return;
      // per-mark space: the pointer position expressed where THIS mark lives
      let ax = x, ay = y;
      if (typeof offsetOf === 'function') {
        const d = offsetOf(a);
        if (d && isNum(d.dx) && isNum(d.dy)) { ax = x + d.dx; ay = y + d.dy; }
      }

      if (a.type === 'pen' && Array.isArray(a.points)) {
        const { touched, runs } = clipPenRuns(a.points, ax, ay, R);
        if (!touched) { annotations.push(a); return; } // nib missed the stroke
        removed.push(a);
        // first piece keeps the id (selection survives); splits get fresh ids
        runs.forEach((pts, i) => annotations.push({ ...a, id: i === 0 ? a.id : genId(), points: pts }));
        return;
      }

      if (a.type === 'highlight') {
        if (hitsMark(a, ax, ay, R)) {
          const pieces = cutHighlight(a.rect || {}, ax, ay, R);
          if (pieces) {
            removed.push(a);
            pieces.forEach((rect, i) => annotations.push({ ...a, id: i === 0 ? a.id : genId(), rect }));
            return;
          }
          // unrepresentable cut → whole delete below
        } else {
          annotations.push(a);
          return;
        }
      } else if (!hitsMark(a, ax, ay, R)) {
        annotations.push(a);
        return;
      }

      removed.push(a); // solid mark, hit → removed whole (contact delete)
    });
    // splits can grow the list a little — same cap rule as addAnnotation
    if (annotations.length > MAX_PER_URL) annotations = annotations.slice(annotations.length - MAX_PER_URL);
    return { doc: { ...doc, annotations }, removed };
  }

  /** Move a mark by dx/dy (viewport px): rect/labelled shapes shift rect;
   *  pen strokes shift every point. Returns { doc, moved }. Immutable. */
  function moveAnnotation(doc, id, dx, dy) {
    if (!doc || !Array.isArray(doc.annotations)) return { doc, moved: false };
    if (!isNum(dx) || !isNum(dy)) return { doc, moved: false };
    const ddx = clamp(Math.round(dx), -1e6, 1e6);
    const ddy = clamp(Math.round(dy), -1e6, 1e6);
    let moved = false;
    const annotations = doc.annotations.map((a) => {
      if (!a || a.id !== id) return a;
      moved = true;
      if (a.type === 'pen' && Array.isArray(a.points)) {
        return { ...a, points: a.points.map(([x, y]) => [x + ddx, y + ddy]) };
      }
      return { ...a, rect: { ...a.rect, x: a.rect.x + ddx, y: a.rect.y + ddy } };
    });
    return { doc: { ...doc, annotations }, moved };
  }

  /** Resize a mark by dw/dh (viewport px deltas). Rectangular marks grow
   *  their rect (floored at MIN_W×MIN_H); pen strokes SCALE around their
   *  bounds' top-left. Returns { doc, resized }. Immutable. */
  function resizeAnnotation(doc, id, dw, dh) {
    if (!doc || !Array.isArray(doc.annotations)) return { doc, resized: false };
    if (!isNum(dw) || !isNum(dh)) return { doc, resized: false };
    let resized = false;
    const annotations = doc.annotations.map((a) => {
      if (!a || a.id !== id) return a;
      resized = true;
      if (a.type === 'pen' && Array.isArray(a.points) && a.points.length) {
        const xs = a.points.map((p) => p[0]);
        const ys = a.points.map((p) => p[1]);
        const bx = Math.min(...xs), by = Math.min(...ys);
        const bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
        const sx = bw > 0 ? Math.max(0.05, (bw + dw) / bw) : 1;
        const sy = bh > 0 ? Math.max(0.05, (bh + dh) / bh) : 1;
        return { ...a, points: a.points.map(([x, y]) => [
          Math.round(bx + (x - bx) * sx),
          Math.round(by + (y - by) * sy)
        ]) };
      }
      return { ...a, rect: { ...a.rect,
        w: Math.max(MIN_W, a.rect.w + dw),
        h: Math.max(MIN_H, a.rect.h + dh) } };
    });
    return { doc: { ...doc, annotations }, resized };
  }

  /** Switch a sticky note's card shape (rect ↔ circle). Other marks are
   *  untouched. Returns { doc, updated }. Immutable. */
  function setAnnotationShape(doc, id, value) {
    if (!doc || !Array.isArray(doc.annotations)) return { doc, updated: false };
    if (!SHAPES.includes(value)) return { doc, updated: false };
    let updated = false;
    const annotations = doc.annotations.map((a) => {
      if (!a || a.id !== id || a.type !== 'sticky') return a;
      updated = true;
      return { ...a, shape: value };
    });
    return { doc: { ...doc, annotations }, updated };
  }

  /** Recolor one mark's TEXT (ink) — works on sticky bodies, text notes and
   *  shape labels alike. `null` returns the ink to AUTO (contrast-chosen on
   *  stickies, mark color on labels). Returns { doc, updated }. Immutable. */
  function setAnnotationTextColor(doc, id, value) {
    if (!doc || !Array.isArray(doc.annotations)) return { doc, updated: false };
    if (value !== null && !isHexColor(value)) return { doc, updated: false };
    let updated = false;
    const annotations = doc.annotations.map((a) => {
      if (!a || a.id !== id) return a;
      updated = true;
      return { ...a, textColor: value || null };
    });
    return { doc: { ...doc, annotations }, updated };
  }

  /** Recolor one mark (palette click with a selection active).
   *  Returns { doc, updated }. Immutable; invalid colors are rejected. */
  function setAnnotationColor(doc, id, value) {
    if (!doc || !Array.isArray(doc.annotations)) return { doc, updated: false };
    if (!isHexColor(value)) return { doc, updated: false };
    let updated = false;
    const annotations = doc.annotations.map((a) => {
      if (!a || a.id !== id) return a;
      updated = true;
      return { ...a, color: value };
    });
    return { doc: { ...doc, annotations }, updated };
  }

  /** Set/replace a mark's text (text tool body or any shape's label).
   *  Empty string clears the label on shapes; the text TOOL keeps its
   *  non-empty guarantee. Returns { doc, updated }. Immutable. */
  function setAnnotationText(doc, id, value) {
    if (!doc || !Array.isArray(doc.annotations)) return { doc, updated: false };
    const clean = String(value == null ? '' : value).slice(0, MAX_TEXT_LEN).trim();
    let updated = false;
    const annotations = doc.annotations.map((a) => {
      if (!a || a.id !== id) return a;
      if ((a.type === 'text' || a.type === 'sticky') && !clean) return a; // body text never goes empty
      updated = true;
      return { ...a, text: clean || null };
    });
    return { doc: { ...doc, annotations }, updated };
  }

  /** Set a mark's TEXT SIZE (S/M/L) — sticky bodies, text notes and shape
   *  labels all render with it. Unknown sizes rejected. Immutable. */
  function setAnnotationTextSize(doc, id, value) {
    if (!doc || !Array.isArray(doc.annotations)) return { doc, updated: false };
    if (!TEXT_SIZES.includes(value)) return { doc, updated: false };
    let updated = false;
    const annotations = doc.annotations.map((a) => {
      if (!a || a.id !== id) return a;
      updated = true;
      return { ...a, textSize: value };
    });
    return { doc: { ...doc, annotations }, updated };
  }

  /** Set TEXT style fields (font family, size, alignment, vertical align,
   *  line spacing, bold/italic/underline) on one mark — the TEXT box uses it
   *  for live edits and defaults.
   *  font/align/valign/size/leading: null clears to the default;
   *  booleans: false removes. Returns { doc, updated }. Immutable. */
  function setAnnotationStyle(doc, id, patch) {
    if (!doc || !Array.isArray(doc.annotations) || !patch || typeof patch !== 'object') return { doc, updated: false };
    const next = {};
    if ('font' in patch) {
      if (patch.font !== null && !isFontName(patch.font)) return { doc, updated: false };
      next.font = patch.font || null;
    }
    if ('align' in patch) {
      if (patch.align !== null && !['left', 'center', 'right'].includes(patch.align)) return { doc, updated: false };
      next.align = patch.align || null;
    }
    if ('bold' in patch) next.bold = patch.bold === true;
    if ('italic' in patch) next.italic = patch.italic === true;
    if ('underline' in patch) next.underline = patch.underline === true;
    if ('valign' in patch) {
      if (patch.valign !== null && !['top', 'middle', 'bottom'].includes(patch.valign)) return { doc, updated: false };
      next.valign = patch.valign || null;
    }
    if ('size' in patch) {
      if (patch.size !== null && !(typeof patch.size === 'number' && Number.isFinite(patch.size) && patch.size >= 6 && patch.size <= 72)) return { doc, updated: false };
      next.size = patch.size ? Math.round(patch.size) : null;
    }
    if ('leading' in patch) {
      if (patch.leading !== null && !(typeof patch.leading === 'number' && Number.isFinite(patch.leading) && patch.leading >= 1 && patch.leading <= 3)) return { doc, updated: false };
      next.leading = patch.leading || null;
    }
    if (!Object.keys(next).length) return { doc, updated: false };
    let updated = false;
    const annotations = doc.annotations.map((a) => {
      if (!a || a.id !== id) return a;
      updated = true;
      const m = { ...a, ...next };
      if (!m.font) delete m.font;
      if (!m.align) delete m.align;
      if (!m.bold) delete m.bold;
      if (!m.italic) delete m.italic;
      if (!m.underline) delete m.underline;
      if (!m.valign) delete m.valign;
      if (!m.size) delete m.size;
      if (!m.leading) delete m.leading;
      return m;
    });
    return { doc: { ...doc, annotations }, updated };
  }

  /** Clear every mark on the page. */
  function clearAnnotations(doc) {
    if (!doc) return emptyDoc(doc && doc.url);
    return { ...doc, annotations: [] };
  }

  root.OrbitabsMarkup = {
    TOOLS, COLORS, INK_COLORS, SHAPES, ERASER, MAX_PER_URL, MAX_TEXT_LEN, MIN_W, MIN_H,
    TEXT_SIZES, TEXT_SIZE_PX,
    normalizeUrlKey, sanitizeAnnotation, genId, hitsMark,
    emptyDoc, addAnnotation, eraseAt,
    moveAnnotation, resizeAnnotation, setAnnotationShape,
    setAnnotationText, setAnnotationColor, setAnnotationTextColor, setAnnotationTextSize,
    setAnnotationStyle,
    clearAnnotations
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
