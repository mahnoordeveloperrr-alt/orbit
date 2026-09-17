# Orbitabs — Reliability Test Suite (Task 15)

Run the automated part first (no Chrome needed):

```bash
node scripts/verify-schema.mjs
```

Then run the manual matrix in real Chrome. Load `dist/` as an unpacked
extension and restart the backend before starting.

> **Honest wording rule** (crash detection can't be 100%): market it as
> *"Designed to safely recover your recent Chrome session after unexpected
> interruptions"* — never *"you will never lose a tab."*

---

## Automated (scripts/verify-schema.mjs)

- v1 shape: capture → save → normalize round-trip
- Legacy `{urls, groups[].urlIndices}` → v1 membership conversion
- Orphan-group and empty-window cleanup
- Corrupt/empty docs → null (never crashes the UI)
- Group-id uniqueness and membership scoping per window

## Manual matrix (real Chrome)

### Test A — Basic
1. Open 5 tabs in one window (distinct sites, distinct order)
2. Orbitabs → Save → note tab order
3. Close ALL tabs → Restore the session

**Expected:** 5 tabs reopen in the exact saved order.

### Test B — Groups
1. One window, 3 named Chrome groups (distinct colors), 5–10 tabs each
2. Save → close window → Restore

**Expected:** 3 groups recreated with same names/colors; every tab back in
its own group; membership identical.

### Test C — Pinned
1. Pin 2 of 6 tabs (one pinned tab inside a group if possible)
2. Save → close → Restore

**Expected:** the same 2 tabs are pinned again; order of pinned block kept.

### Test D — Multiple windows
1. Window 1 with a Research group, Window 2 with a Work group + loose tabs
2. Save (scope: All windows) → close both → Restore

**Expected:** both windows return with their own groups; focus lands on the
saved focused window. (Note: minimized windows restore after Chrome focuses
something — acceptable; check tabs/groups are intact.)

### Test E — Large session
1. Open 50 tabs → Save/Restore; measure popup save + restore time
2. Repeat with 100 tabs

**Expected:** completes without timeout; UI stays responsive; debounced
auto-save does not fire per-tab.

### Test F — Tab changes / auto-save
1. Open the Live Backup (AUTO) card → expand and count tabs
2. Move a tab, close a tab, add a tab, rename a group, collapse a group
3. Wait ~2 min, reopen popup

**Expected:** Live Backup reflects the changes (debounced, ≤1–2 min old).
Saved named sessions are NOT touched.

### Test G — Crash recovery
1. Open several grouped tabs → wait ≥1 min (heartbeat)
2. Kill Chrome via Task Manager (do NOT close windows)
3. Relaunch Chrome → check toolbar badge "!" and the amber banner

**Expected:** "Chrome crashed — restore N tabs?" appears; Restore rebuilds
windows/groups; Dismiss clears badge and prompt. After a NORMAL close
(last-window close), the next start must NOT show the prompt.

### Test H — Delete / Undo
1. Delete a session → confirm dialog "Move to Trash" → Undo within 7s
2. Delete again, don't undo → Trash view → Restore from Trash
3. Empty Trash with nothing important inside → confirm

**Expected:** every path recoverable; only explicit "Delete forever" purges.

### Test I — No account
1. Fresh profile, install dist/, do NOT sign in
2. Save, Restore, Quick Save, delete/undo, check Live Backup card

**Expected:** everything works with zero account. Cloud icon shows "off".

### Test J — Existing Chrome groups (golden rule)
1. Set up groups BEFORE touching Orbitabs
2. Open Orbitabs, browse Sessions, save, restore a DIFFERENT session
3. Organize view: refresh only

**Expected:** pre-existing groups are untouched unless you explicitly
drag/edit them in Organize. Restore never regroups unrelated tabs.

### Test K — Recovery points (corrupted-latest recovery)
1. Open a few tabs → wait ≥10 min (or use ⚙️ → Snapshot now twice, 5+ min apart) —
   Diagnostics should list up to 5 recovery points
2. Change your tabs significantly (close windows, open new ones)
3. ⚙️ Diagnostics → pick an OLDER recovery point → Restore

**Expected:** the OLD state reopens as new windows (tabs/groups as they were
at that point); your CURRENT tabs/windows are untouched (additive restore).
Use case: latest snapshot corrupted/overwritten — you can always fall back
to a historical point.

### Test L — Keyboard shortcuts (commands API)
1. Load/reload `dist/`, then check `chrome://extensions` → Orbitabs → **Details → Keyboard shortcuts**
   (defaults: **Alt+Shift+S** quick-save, **Alt+Shift+R** restore-last; user-remappable there)
2. With tabs open (try a group + a pinned tab), press **Alt+Shift+S**
3. Open the popup → Sessions
4. Press **Alt+Shift+R** after closing all windows
5. Press **Alt+Shift+R** again immediately (double fire)
6. Fresh profile with nothing saved: press **Alt+Shift+R**
7. Toggle auto-save OFF in Settings → press **Alt+Shift+S**

**Expected:** step 2 pulses a green ✓ on the toolbar badge (~1s); step 3 shows a
"Quick Save — <date> (N tabs)" card at the top with your groups/pinned intact;
step 4 reopens the newest saved session (additive, same as popup Restore);
step 5 duplicates the restore (Chrome's own additive-restore semantics — see
Test D note); step 6 is a silent no-op; step 7 still saves (explicit actions are never gated — only the passive
Live Backup obeys the auto-save toggle; an empty session is still refused).
Quick Save works with NO account — it never touches the cloud.

### Test M — Export / Import (backup & share)
1. Settings → **Backup & Share** → **Export JSON**
2. Open the downloaded `orbitabs-backup-YYYY-MM-DD.json` in an editor
3. **Import JSON** → pick that same file → confirm the "ADDED to your list" dialog
4. Import the same file AGAIN
5. Hand-edit the file: rename `kind` to something else → import
6. Hand-edit: replace one session with `{}` and keep the rest → import
7. Import a random `.json` (not a backup) / press Cancel in the file picker
8. Delete a session to Trash → Export → check the file

**Expected:** step 1 downloads immediately with a green status line;
step 2 shows `"kind": "orbitabs-backup"`, `version: 1`, one entry per session
with full `windows[]`; step 3 adds sessions to the top of the list (names and
save dates preserved, NEW ids — nothing overwritten); step 4 duplicates them
(imports are additive by design); step 5 is rejected with a clear error;
step 6 imports the good entries and reports "1 bad entry skipped"; step 7
shows a friendly error / Cancel is a silent no-op; step 8 the trashed session
is NOT in the file (trash excluded).

### Test N — Error boundary (popup can never go blank)
1. Load `dist/`, open the popup — normal UI
2. Simulate a crash: temporarily patch any component's render to
   `throw new Error('x')` (or trust the automated suite), then reopen the popup
3. Inspect what renders instead of the app
4. Note whether the crash-recovery banner is still offered on that screen
5. Click **Restore** / **Dismiss** on that banner
6. Click **Try again** after removing the thrown error

**Expected:** step 3 shows the “Orbitabs hit a snag” emergency screen — never a
white/empty popup — with the reassurance that saved sessions are safe; step 4
the crash-recovery banner IS still offered (it is guarded by its own nested
boundary); step 5 both banner actions still work from the emergency screen;
step 6 “Try again” re-renders the real app once the cause is gone. Broken
nested widgets (non-emergency boundaries) are removed silently without taking
their siblings down.

### Test O — Settings control room (every toggle changes real behavior)
1. Settings → General → toggle **Auto-save** OFF → watch the popup for ~1 min
2. Auto-save back ON → set **Auto-save frequency** to Every 60 seconds
3. Set **Save scope** to "Current window" → open two Chrome windows → Save
4. Set **Restore behavior** to "Current window" → Restore a saved session
5. Toggle **Restore pinned tabs / active tab / groups** OFF one by one → restore a session with pins + groups
6. Backup & Recovery → toggle **Live Backup** OFF → wait one heartbeat → check the session list
7. Toggle **Crash Recovery** OFF → close Chrome uncleanly → relaunch
8. Set **Maximum recovery points** to 3 → browse a few minutes → Diagnostics
9. Privacy & Data → toggle **Local-only mode** ON → try enabling **Cloud sync**
10. Keyboard Shortcuts → **Change in Chrome's shortcut settings**
11. Data Management → **Reset Orbitabs** → read the dialog → confirm

**Expected:** step 1 no snapshot/Live Backup writes happen (diagnostics "Last
save" freezes); step 2 the heartbeat alarm re-arms immediately (no browser
restart needed); step 3 the Save bar starts in "This window" mode; step 4
restored tabs open in the CURRENT window — no new windows; step 5 restores
without pins, without re-focusing, without rebuilding groups; step 6 no
"Auto-save — Live Backup" card at the top of the list; step 7 no recovery
banner and no `!` badge; step 8 the recovery history never exceeds 3 points;
step 9 cloud sync flips itself OFF (local-only is the hard guarantee) and the
worker reports `skipped: local-only`; step 10 Chrome's shortcuts page opens;
step 11 the dialog states exactly what will be erased (session counts included)
and confirming restores defaults — saved sessions, trash, snapshots, recovery
history and settings are gone; a non-Orbitabs key would survive.

---

### Test P — Day-4 UI/UX pass (fresh Chrome profile, in order)
1. Install `dist/` as unpacked → open the popup
2. Click **Save My Current Tabs** on the welcome card (or the big Save button)
3. Save 10 tabs (some in Chrome tab groups) with a custom name
4. Close Chrome completely → reopen → click the toolbar icon
5. Click **Restore** on the recovery banner (or restore a saved session)
6. Settings → toggle **Auto-save** OFF, then ON
7. Session ⋯ menu → **Export** → check the downloaded JSON
8. Settings → **Import data** → pick that file → confirm
9. Delete a session → confirm **Move to Trash**
10. Click **UNDO** on the toast
11. Kill Chrome from Task Manager → relaunch
12. Restore a session where 1+ tab URL is dead (e.g. `chrome://` from another
    profile, or an expired link)

**Expected (mapped):**
- T1 Welcome card with "Save your Chrome tabs, groups and windows…" + CTA +
  "stores your sessions locally by default. No account required."
- T2 toast: "✓ Saved successfully — N tabs · M windows"; the new session card
  is at the top of **Your Sessions** with a stats line + "Saved just now"
- T3 the card shows group chips (color dot · name · count) before any restore
- T4 clean exit → NO recovery banner, no `!` badge; the dashboard renders
- T5 toast "✓ Session restored — N tabs · M windows"; tabs/windows/groups back
- T6 the header dot flips to "Auto-save OFF" instantly and the worker actually
  stops snapshotting (diagnostics "Last save" freezes); flips back ON
- T7 toast "Session exported"; the file opens as a valid orbitabs-backup JSON
- T8 toast "Imported 1 session"; the copy appears at the top (" (copy)" naming
  only applies to Duplicate — import keeps its name)
- T9 confirm dialog says "Move to Trash?"; the card leaves the list
- T10 toast disappears, the session is back in the list
- T11 crash → `!` badge → recovery banner "Chrome crashed — restore N tabs?"
- T12 toast "⚠ Session partially restored — X of N tabs restored."

Also verify during this pass: no console errors in the popup, disabled-looking
buttons are actually disabled, every button does something (no dead buttons),
empty state shows "Your saved sessions will appear here." with a working CTA,
and dark mode (cycle the theme button) has no white slivers or unreadable text.

---

### Test Q — Orbitabs Markup (V1.1 MVP, fresh profile)

1. Load `dist/`, then **reload once any already-open page** (content scripts
   attach on page load — new pages need no reload). Click the popup's
   **pen icon** (header) → the transparent overlay opens directly on the
   page with the toolbar (pen, highlight, rect, circle, arrow, T, colors,
   undo, redo, clear, save, close).
2. Draw with every tool; press **Save** (💾) → "Saved ✓". Close (✕) and
   reopen on the same page → marks come back from `orbi_annotations`, and a
   toast shows the count. Also verify the interactions: **cursor tool drags
   marks** to a new position; typing a note and **clicking away commits it**
   (blur = save, Esc = discard); after drawing a rectangle/circle a small
   input offers an optional **label on the shape** (double-click a mark with
   the cursor tool to edit it later).
3. **Palette & selection (v1.3.1):** toolbar shows **10 color swatches + a
   🎨 any-color picker**. Click a mark with the cursor tool → dashed blue
   selection outline → click another swatch (or 🎨) → the mark **recolors
   live** and persists after Save. Type a text note → it commits **already
   selected** (drag it immediately, or recolor it with one palette click).
   Arrows show a **start dot** and their head never overshoots on short
   drags.
4. **Sticky notes (v1.4):** pick the **sticky tool** (card icon) → draw the
   card to any size → type inside (Enter/click-away commits, Esc discards)
   → the card auto-selects with an **SE corner handle** → drag the handle to
   resize (min 20×14) → **Shape picker** appears above the hint bar → switch
   the card **rect ↔ circle** → double-click a note to edit its body → text
   inside stays readable on every fill color (dark ink on light fills, light
   on dark).
5. **Text ink / font color (v1.4.1):** the toolbar's second swatch row is
   the **TEXT color** (A = auto-contrast, 5 inks, A-picker). Type a note →
   click an ink → committed text recolors. **Edit a note (double-click) and
   click inks while typing** → the text on the canvas recolors LIVE; Esc
   puts the original ink back; commit keeps it. An ink chosen before typing
   becomes the new note's ink. Selected-but-not-editing marks also recolor
   from ink clicks.
6. **Eraser + snapshot undo (v1.4.2):** the toolbar's eraser icon — click
   or drag across marks, everything the cursor touches disappears (the
   cursor shows a cell/box shape). **Undo brings erased marks back verbatim**
   — and undo/redo now also cover MOVE, RESIZE, RECOLOR and label edits,
   not just drawing. Clear (🗑) is undoable too.
8. **Text sizes S/M/L (v1.4.3):** the size row in the toolbar — pick S, M
   or L, then type a note (it renders at that size); double-click an existing
   note/sticky and switch sizes MID-edit (live repaint; Esc restores); or
   select any mark and click a size to resize its text instantly.

7. **Compact palettes (v1.4.2):** 6 fill swatches (yellow red green blue
   black white) + 🎨 any-color picker; ink row = A auto + 5 inks + A-picker.
   Older marks with retired colors still render (storage keeps any hex).
8. The website itself is untouched (data-only annotation layer — no
   DOM/content edits; everything Orbitabs adds is its own fixed-position
   layer, removed on ✕).
9. `chrome://extensions` → Orbitabs lists **scripting** and **activeTab**
   in permissions (justification: activeTab grants one-tab temporary access
   when the user clicks the pen; scripting only injects OUR overlay files —
   never broad host permissions).
10. Open Markup on a non-web tab (chrome://settings) → popup shows the
   friendly refusal, nothing breaks.
11. Re-check: popup never blank, no console errors on the page.

## Known limitations to watch during testing

- Chrome's own "Restore pages?" bubble may duplicate tabs if you accept it
  and then use Orbitabs recovery (same as other session managers).
- Minimized-window state restore is best-effort (Chrome API behavior).
- MV3 worker may be evicted mid-session on very long idle; alarms re-fire
  and re-capture, so staleness stays ≤1 min.
- Keyboard shortcuts only fire while Chrome is focused; if the worker was
  evicted, the command cold-starts it (first press may feel ~100–300ms slow).
- If another extension already owns Alt+Shift+S / Alt+Shift+R, Chrome leaves
  ours unbound — assign different keys in chrome://extensions/shortcuts.

## Day 5 — primary task (beta polish)

- **UI alignment/overflow sweep (PRIMARY):** audit every page at 420×560 —
  truncated/wrapped stat lines, misaligned chips, cramped section spacing,
  content overflowing card bounds. Fix at the layout level (flex/grid rules),
  not one-off pixel nudges, and re-run the UI smoke suites after.
- Secondary: confirm import edge cases on a real install (duplicate re-import,
  newer-version file, file with only garbage entries).

## Day 5 — Real-Chrome recovery drill (manual, ~10 min, fresh profile)

The scripted suites prove the logic; this drill proves the **real worker +
real Chrome lifecycle** end to end. Every step lists the expected outcome —
any mismatch is a bug to file before V1 freeze.

1. **Clean-exit baseline.** Load `dist/` (Developer mode → Load unpacked),
   open 4 tabs, wait ≥35s (auto-save fires), quit Chrome normally via the
   menu. Relaunch → popup must show NO recovery banner (clean exit flag set).
2. **Crash recovery.** With tabs open, kill Chrome from Task Manager
   (or `taskkill /F /IM chrome.exe`) — never the menu. Relaunch → popup must
   show the recovery banner with the tab count; Restore reopens the tabs.
3. **Corrupted-latest point.** In the popup's DevTools console run
   `chrome.storage.local.set({recoveryPoints: [{savedAt: 'garbage'}]})`, then
   trigger a crash again. Recovery must fall back to the previous good
   point (or show none) — never crash the popup.
4. **Partial restore.** Export a session, hand-edit the JSON: rename the
   session (new name → the duplicate gate won't skip it) and add the dead
   URL `https://dead.invalid/x` to its tabs, import it, restore it. Restore
   must report "partially restored — N of M tabs".
5. **Settings survive restart.** Set frequency to 5 min, scope to Current
   window, quit and relaunch Chrome — Settings page must show the same
   values (B1b covers the store; this covers the real worker).
6. **Kill-and-revive the worker.** From chrome://extensions hit the service
   worker "Stop" (or wait for eviction), then press Alt+Shift+S. The command
   must cold-start the worker and save within a couple of seconds.

Pass criteria: steps 1–6 all match, popup never blank, no console errors in
the popup or the worker.
