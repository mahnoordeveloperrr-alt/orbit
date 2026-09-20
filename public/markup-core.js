// 🖊 ORBITABS MARKUP — CORE (pure logic, zero DOM / zero chrome.*)
// ------------------------------------------------------------------
// The annotation engine behind the Markup overlay. Data-not-pixels:
// every mark is a structured record (see MARKUP_SPEC.md §2) keyed by
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

  const TOOLS = ['pen', 'highlight', 'rect', 'circle', 'arrow', 'text', 'sticky'];
  // Compact fill palette: yellow red green blue black white (+ the 🎨 picker
  // in the UI covers everything else). Storage keeps ANY valid hex, so older
  // marks with retired colors still render.
  const COLORS = ['#facc15', '#ef4444', '#22c55e', '#8b5cf6', '#111827', '#f8fafc'];
  // Ink palette — TEXT color, compact: auto + these 5.
  const INK_COLORS = ['#111827', '#f8fafc', '#ef4444', '#8b5cf6', '#22c55e'];
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

  const isHexColor = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
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
      w: isNum(r.w) ? clamp(Math.round(r.w), 0, 1e6) : 0,
      h: isNum(r.h) ? clamp(Math.round(r.h), 0, 1e6) : 0
    };

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
    if (shape) out.shape = shape;
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

  /** Eraser: remove EVERY mark within radius r of (x, y), using the shared
   *  hit geometry. Returns { doc, removed: Annotation[] } — the removed marks
   *  themselves, so the caller can undo/restore them verbatim. Immutable. */
  function eraseAt(doc, x, y, radius) {
    if (!doc || !Array.isArray(doc.annotations)) return { doc, removed: [] };
    if (!isNum(x) || !isNum(y)) return { doc, removed: [] };
    const R = isNum(radius) && radius > 0 ? radius : ERASER.RADIUS;
    const removed = [];
    const annotations = doc.annotations.filter((a) => {
      if (!a) return false;
      const hit = hitsMark(a, x, y, R);
      if (hit) removed.push(a);
      return !hit;
    });
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

  /** Clear every mark on the page. */
  function clearAnnotations(doc) {
    if (!doc) return emptyDoc(doc && doc.url);
    return { ...doc, annotations: [] };
  }

  root.OrbitabsMarkup = {
    TOOLS, COLORS, INK_COLORS, SHAPES, ERASER, MAX_PER_URL, MAX_TEXT_LEN, MIN_W, MIN_H,
    TEXT_SIZES, TEXT_SIZE_PX,
    normalizeUrlKey, sanitizeAnnotation, genId,
    emptyDoc, addAnnotation, eraseAt,
    moveAnnotation, resizeAnnotation, setAnnotationShape,
    setAnnotationText, setAnnotationColor, setAnnotationTextColor, setAnnotationTextSize,
    clearAnnotations
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
