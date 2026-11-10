# Orbitabs Markup — V1.1 Mini-Spec

> **Status:** MVP SHIPPED (V1.1) · **v1.4: sticky notes** — full card notes
> (draw-to-size, type inside, SE-corner resize, rect ↔ circle shape picker,
> contrast ink) shipped in `markup-core.js`/`markup-overlay.js`.
> **v1.4.1: ink (text color)** — a dedicated TEXT-color palette (11 inks +
> auto + custom picker): recolor text after typing, live DURING typing
> (canvas preview, Esc restores), or as the default for new marks.
> The coordinate-based overlay MVP now lives
> in the codebase (`public/markup-core.js`, `markup-overlay.js` + `.css` as
> the in-page content-script overlay, popup pen button,
> `scripts/markup.test.mjs`). The spike questions were resolved as: the
> overlay app IS the isolated-world content script (popup messages it open;
> `chrome.scripting` only as an install-time fallback), DPR/zoom handled by
> the browser at overlay render time, canonical URL normalizer (shared rules
> in `markup-core.js`), per-page caps + eviction (oldest-first).
> **Scroller-chain anchoring (v1.5):** every mark records the scrollable
> ancestors it was drawn inside (numeric snapshot + a re-resolvable path),
> so it rides both window AND inner-container scrolling — see §3.
> **Core promise:** *Mark important parts of any webpage and keep those notes
> with your saved research session.*

---

## 1. What it is

A transparent **annotation overlay** on top of any webpage. The user opens
Markup from the popup (Pen icon on a saved session's tab, or "Markup this
page" on the current tab), draws/highlights/types on the overlay, and the
annotations are stored as **data** — keyed to the page URL — inside the
session that tab belongs to.

**The original website is never modified.** No DOM edits, no scripts injected
into the page's own context, nothing persisted into page storage. Markup is
Orbitabs' layer, drawn above the page and removable with one click.

```
Web Page (untouched)
   ↓
Orbitabs Annotation Layer (transparent, our extension page)
   ↓
User creates markup → annotation DATA saved (type, coords, color, text)
   ↓
Associated with the saved session that contains this URL
   ↓
Session restore → tabs reopen → annotations re-drawn on top
```

## 2. Why data, not pixels (the one non-negotiable)

Annotations are **never baked into a screenshot**. Each annotation is a
structured record:

```jsonc
{
  "id": "an_01J9...",            // unique, generated at draw time
  "url": "https://example.com/article",
  "sessionId": "sess_...",       // session this page's markup belongs to
  "type": "highlight",           // pen|highlight|rect|circle|arrow|text|sticky
  "rect": { "x": 500, "y": 700, "w": 220, "h": 90 },  // PAGE (document) coords
  "points": [[x, y], ...],       // pen strokes only
  "color": "#facc15",
  "text": "Need to verify this claim.",
  "createdAt": "2026-09-17T10:32:00.000Z"
}
```

This is what keeps annotations **editable, undoable, searchable, exportable**
— and the site untouched.

## 3. Positioning: page coordinates + scroller-chain anchoring

Websites are responsive; `x:500, y:700` today may be elsewhere tomorrow.
V1.1 stores every mark in **page (document) coordinates** and renders with a
scroll-matched transform (input converted to page coords, canvas translated
by −scrollX/−scrollY each frame), so annotations survive:

- ✅ scrolling while annotating — marks track their content 1:1; the page
  never scrolls from a mark gesture, and a mark never drifts
- ✅ same layout, different window size (marks keep their page position)
- ⚠️ layout reflow moves text under the mark (mark stays on its page spot)

### Inner-scroll containers (v1.5 — X/Gmail/Reddit/Notion-style feeds)

Sites like Twitter/X, Gmail, Reddit and Notion scroll an **inner div**, not
the window — `window.scrollY` stays 0 there, and a plain page-space mark
freezes while its paragraph slides away. Every mark therefore also records
the **scroller chain** it was drawn inside:

- **Capture:** `captureAnchor()` walks up from the element under the pointer
  (overlay elements excluded) collecting scrollable ancestors — live element
  refs `els` + their `scrollTop/scrollLeft` snapshot `sx/sy` + a **path**
  descriptor per scroller (`tag`, nth-of-type index, `id` hint).
- **Render:** `anchorDelta()` = how far those containers scrolled since the
  snapshot; `drawInMarkSpace()` shifts the mark by −delta, so it rides its
  content on **both** axes and for window scroll too (window translate is
  applied globally, container deltas per mark).
- **Input:** hit-testing, drag, resize, eraser and the text-note editor all
  convert through `toMarkSpace()` — every gesture runs in the mark's own
  frame, so a note inside a scrolled div stays pickable and movable exactly
  where it renders. Dragging a mark never scrolls the page (pointer
  capture + `touch-action`/pan cancel only while a gesture owns the pointer).
- **Reload (F5):** element refs can't be stored, so `saveDoc()` persists the
  numeric snapshot + `path`; on load `reattachAnchors()` re-resolves the
  chain — an `id` match is trusted, the positional fallback only fires when
  the page's same-tag scroller census still matches, and an unresolvable
  path falls back to `[]` (classic window-space — **never** a wrong
  container). Detached containers (SPA nav) contribute 0.
- **One CSS invariant the capture depends on:** the overlay root is
  `pointer-events: none` (canvas/dock children/editor opt back in with
  `auto`). Otherwise `elementFromPoint` returns the overlay itself, the
  anchor walk starts at the root, and every chain comes back empty — marks
  then freeze while the site scrolls. `elementUnderPage()` additionally
  walks `elementsFromPoint` and skips anything inside the overlay, so a
  foreign overlay can't hijack the query either.

**Text-node/DOM anchoring** (attach to a specific text node so marks follow
reflow) remains a V1.2 idea — scroller-chain anchoring fixes scrolling, not
reflow, but adds no selector fragility.

### Known-hard pages (documented, not hidden)

Google Docs, YouTube, infinite-scroll feeds, canvas apps: content there is
programmatic and virtualized — elements are created/destroyed as you scroll —
so a fixed page coordinate can point at different content later.
V1.1 shows a small notice on such pages: *"Markup on this page may not
restore to the exact spot."* The feature is honestly named **Page markup** —
a universal annotation engine it is not (yet).

## 4. Tools (V1.1 = exactly these seven controls + color)

Floating toolbar over the page:

| Tool | Behavior |
|------|----------|
| ✏️ Pen | Freehand stroke (points[] captured) |
| 🖍 Highlight | Semi-transparent wide stroke/rect over text area |
| ⬜ Rectangle | Drag to mark an area |
| ⭕ Circle | Drag to ring a specific item |
| ↗ Arrow | Drag from tail to head — point at something (start dot marks the tail) |
| 📝 Text | Click, type a short note, click away to commit |
| 🗒 Sticky | **Card note (v1.4):** draw the card to any size → type inside → resize from the SE corner handle → switch the card shape (rect ↔ circle) from the shape picker → drag/recolor like any mark |
| 🧽 Eraser | Click or drag across marks — everything the cursor touches is removed (one undo per stroke) |
| ⌘ Cursor | Select/move/resize marks; double-click a note to edit its body |
| ↩ Undo / ↪ Redo | Per-page stroke stack |
| 🗑 Clear | All annotations on THIS page (confirm-gated) |

Plus a **color row** (14 fills + 🎨), a **TEXT-ink row** (A auto, 11 inks,
A-picker) — v1.4.1, and a **text-size row** (S 12px · M 15px · L 18px —
v1.4.3: `textSize` per mark, `setAnnotationTextSize`, live mid-edit, Esc
restores). No more tool types — resist feature creep.

> **v1.4 note:** the sticky note was pulled forward from "Later" (user
> request): TOOLS now includes `sticky`, annotations may carry `shape:
> rect|circle`, and marks can be resized (`resizeAnnotation`, floored at
> 20×14 so a mark never collapses). The V1.1 freeze on tool types is
> consciously superseded by this single, well-bounded addition.

## 5. Storage & association

- Annotations live in `chrome.storage.local` under an Orbitabs-owned key
  (`orbi_annotations`), as `{ [url]: Annotation[] }`, capped per page
  (e.g. 200) and per total size.
- **Association rule:** an annotation belongs to a URL; when that URL is part
  of a saved session, the session's restore count shows annotation badges
  (e.g. `OpenAI article — 3 highlights · 1 note`).
- Session card shows an aggregate: `Research — 12 tabs · 4 annotated pages`.
- Deleting a session offers (checkbox, default ON) "delete its annotations
  too". Trash restore brings annotations back from an `orbi_annotations_trash`
  mirror, same retention rules as sessions.

## 6. Restore flow (the payoff)

1. User restores session → tabs open (existing V1 restore, untouched).
2. Worker/popup loads `orbi_annotations[url]` for each restored tab.
3. Orbitabs shows a subtle edge-pip on annotated tabs; opening the page
   re-renders the overlay from data (rescaled per §3).
4. The user is back with their **research context**, not just URLs:
   highlights, "STOP HERE" markers, verify-this notes — where they left them.

## 7. UI entry points

- Popup header action on any page: the **pen button** opens the overlay
  directly (the content script IS the overlay — no intermediate chip/page).
- Session card tab list → pen icon per URL (annotated tabs get a filled
  dot) — planned with session-annotation badges.

## 8. Later (explicitly NOT V1.1)

Sticky-note cards · "read until here" auto-marker · annotation search across
sessions · annotation list panel · export annotated research (PDF/screenshot)
· per-session research summary · annotation text feeding global search
(`tabs + groups + notes`). These stay out until V1.1 ships and proves the
overlay+restore loop on real pages.

## 9. Open technical questions (to answer in a V1.1 spike, before build)

1. Overlay injection approach: `chrome.scripting.executeScript` mounting an
   iframe vs a side-panel-hosted editor — pick after testing on 5 hostile
   pages (Docs, YouTube, arXiv, a Twitter thread, an infinite-scroll feed).
2. Device-pixel-ratio and browser-zoom normalization for coordinates.
3. Per-URL vs per-URL+query matching (tracking params break exact match —
   need a canonical-URL normalizer shared with session search).
4. Size caps + eviction policy when `orbi_annotations` grows.
