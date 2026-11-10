# Orbitabs — Test Results (Tests A–J)

**How to fill this:** run each test in order, tick ✅/❌, and write one line
under "Notes" describing what you actually saw (a mismatch detail is worth
more than a pass mark). Paste the whole file back to me — I'll root-cause
every ❌ and fix.

## Setup (once)

1. `chrome://extensions` → enable **Developer mode** (top-right toggle)
2. Click **Load unpacked** → select this project's **`dist/`** folder
3. Pin "Orbitabs" to the toolbar (puzzle icon → pin)
4. If you use cloud sync: restart the backend (`tab-saver-backend`) — optional,
   everything below works without an account
5. **Diagnostics panel**: popup → ⚙️ (gear, top-right). You'll see
   *Live snapshot / Heartbeat / cleanExit / Recovery points / Crash queued*.
   Use **Snapshot now** to force a capture. This is your ground truth for
   Tests F & G.

---

## Test A — Basic save/restore
| Step | Result | Notes |
|---|---|---|
| Open 5 tabs → Save → card appears with "(5 tabs)" | ☐ | |
| Close all tabs → Restore → 5 tabs back | ☐ | |
| Order identical to saved | ☐ | |

## Test B — Groups
| Step | Result | Notes |
|---|---|---|
| 3 named groups, 5–10 tabs each → Save | ☐ | chips show counts? |
| Close window → Restore → 3 groups back | ☐ | |
| Same titles + colors | ☐ | |
| Same membership (tabs in own groups) | ☐ | |

## Test C — Pinned
| Step | Result | Notes |
|---|---|---|
| Pin 2 of 6 tabs → Save → close → Restore | ☐ | |
| Same 2 tabs pinned, order kept | ☐ | |

## Test D — Multiple windows
| Step | Result | Notes |
|---|---|---|
| Window 1 (Research group) + Window 2 (Work group + loose tabs) | ☐ | |
| Save (scope "All windows") → close both → Restore | ☐ | |
| Both windows return, groups intact | ☐ | focus lands on saved focused window |

## Test E — Large session
| Step | Result | Notes |
|---|---|---|
| 50 tabs: Save + Restore time acceptable | ☐ | ~seconds? |
| 100 tabs: still completes, popup responsive | ☐ | |

## Test F — Auto-save (use Diagnostics)
| Step | Result | Notes |
|---|---|---|
| Move/close/add a tab, rename a group | ☐ | |
| ⚙️ → Refresh: "Live snapshot" reflects change within ~2s | ☐ | |
| Heartbeat ≤ 60s old while Chrome open | ☐ | |
| Live Backup (AUTO) card updates | ☐ | |
| Saved named sessions NOT modified by auto-save | ☐ | |

## Test G — Crash recovery (use Diagnostics)
| Step | Result | Notes |
|---|---|---|
| Open tabs → wait ≥1 min → Task Manager → kill Chrome | ☐ | |
| Relaunch → red "!" badge + amber banner "Chrome crashed — restore N tabs?" | ☐ | |
| Restore rebuilds windows/groups | ☐ | |
| Dismiss clears badge and banner | ☐ | |
| Normal close (X on last window) → relaunch → NO banner | ☐ | |
| Diagnostics after normal close: cleanExit = yes | ☐ | |

## Test H — Delete / Undo / Trash
| Step | Result | Notes |
|---|---|---|
| Card trash icon → confirm dialog → Move to Trash → UNDO within 7s | ☐ | |
| Delete without undo → 🗑 Trash → Restore from Trash | ☐ | |
| Empty Trash / Delete forever → confirm-gated | ☐ | |

## Test I — No account (fresh profile)
| Step | Result | Notes |
|---|---|---|
| Load dist/ in a new profile, never sign in | ☐ | |
| Save / Restore / Quick Save / delete+undo all work | ☐ | |
| Live Backup (AUTO) card appears on its own | ☐ | |
| Settings shows "Cloud sync: off" | ☐ | |

## Test J — Existing groups untouched (golden rule)
| Step | Result | Notes |
|---|---|---|
| Groups exist BEFORE Orbitabs → open popup, browse, save | ☐ | |
| Groups unchanged | ☐ | |
| Restore some OTHER session → pre-existing groups unchanged | ☐ | |
| Organize tab: refresh only → nothing regrouped | ☐ | |

## Test K — Recovery points (corrupted-latest recovery)
| Step | Result | Notes |
|---|---|---|
| ⚙️ Diagnostics lists 1–3 recovery points (tabs/win + age) | ☐ | needs ≥5 min between captures |
| Change tabs → Restore an OLDER point → old state reopens as new windows | ☐ | |
| Current tabs/windows untouched (additive) | ☐ | |

---

## Environment (fill once)

- Chrome version: `chrome://version` → ______
- OS: ______
- Profiles tested: main / fresh
- Anything unusual: ______
