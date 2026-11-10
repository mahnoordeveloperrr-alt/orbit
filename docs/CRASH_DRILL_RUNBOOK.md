# 🚨 Crash-Recovery Drill — Manual Runbook (installed extension)

**Why this is manual:** Chrome only dispatches `chrome.runtime.onStartup` to an
extension that is already part of the profile **before** the browser starts.
Every programmatic loader available to automation registers the extension
*after* startup, so the event never arrives. This was proven, not assumed —
see [Evidence](#evidence-automation-cannot-deliver-onstartup) below.

The drill itself is 6 steps and every pass criterion is **observable on screen**.
It is the last open verification item for crash recovery (all of its *logic* is
already covered by VM suites A1–A3 and the seeded-UX run `crashux` 19/19).

---

## Prerequisites (once)

1. Chrome → `chrome://extensions` → enable **Developer mode** (top-right).
2. Click **Load unpacked** → select this project's **`dist/`** folder.
3. Pin Orbitabs to the toolbar. Note the extension should show version **1.4.3**
   and no errors ("Errors" link must say "No errors").
4. Open the extension popup → ⚙️ gear (top-right) → find the **Recovery
   history** panel. Note the **Startup check** stat — right now it should read
   `Never`.

> After the drill, **Startup check** must show `Xm ago (entered)`. That value
> is written by exactly one place: the `chrome.runtime.onStartup` listener in
> `public/background.js` — seeing it is direct proof the platform event fired
> for a genuinely installed extension.

## Drill

| # | Action | What to expect (record it) |
|---|---|---|
| 1 | Open **3–6 tabs** (any sites), in **2 windows** if you like. Wait **10 seconds**. | Popup → ⚙️ → **Last save** shows "`…s ago`" (snapshot captured). **Live tabs** matches your tab count. |
| 2 | Note **Heartbeat** and **Clean exit = No (running)** in the same panel. | Heartbeat age ≤ ~35s. |
| 3 | **Kill Chrome hard**: Task Manager → end every `chrome.exe` process (or run `taskkill /F /IM chrome.exe` in a terminal). **Do not** close it normally — that would be a clean exit. | Chrome windows vanish instantly. No "restore pages?" prompt is fine either way (Chrome-side, unrelated). |
| 4 | **Relaunch Chrome** normally (your usual icon). | Chrome comes back with your tabs (session restore) **and** — wait up to ~5s — Orbitabs shows **badge "!"** on its toolbar icon. |
| 5 | Open the Orbitabs popup. | Banner: **"Chrome crashed — restore N tabs?"** with correct N, a **"Last saved …"** line, and buttons **Not now** / **Restore tabs**. |
| 6 | Click **⚙️ gear** → **Recovery history** panel. | **Startup check** = "`Xm ago (entered)`" ✅ (this is the onStartup delivery proof). **Crash detected — restore available** chip visible. Then click **Restore tabs** in the banner → windows/tabs/groups come back; banner + badge clear; **Startup check** still shows `(entered)`. |

### Pass = all of:
- [ ] Badge `!` after relaunch (no manual action needed to see it)
- [ ] Banner with **correct tab count** and "Last saved …" line
- [ ] **Restore tabs** rebuilds the killed session (tabs, order, groups, pins)
- [ ] **Startup check** shows `… (entered)` — the onStartup marker
- [ ] After restore: banner gone, badge cleared

File the completed table (or a screenshot of the popup + gear panel) back here
and I will root-cause anything red.

### Why kill instead of close
Normal quit runs the extension's clean-exit path (`cleanExit = true`) and the
restart correctly offers **no** recovery banner. The drill specifically needs
the *unclean* path: SIGKILL-style termination leaves `cleanExit = false` with a
snapshot from the last 12h → banner must appear.

---

## Evidence: automation cannot deliver onStartup

Probed on Chrome-for-Testing **155.0.8059.39** with
`lastStartupCheck` (written *only* inside the `onStartup` listener):

| Load method | onInstalled (cleanExit/lastAlive written) | onStartup marker |
|---|---|---|
| `--disable-extensions-except` (loads the unpacked dir) | ✅ fired | ❌ absent |
| `--load-extension` + `--disable-extensions-except` | ✅ fired | ❌ absent |
| CDP `Extensions.loadUnpacked` (+flags) | ✅ fired | ❌ absent |

All three: `lastStartupCheck` missing after 7s idle ⇒ event never dispatched.
Supporting facts:
- `Extensions.loadUnpacked` does **not** persist the extension — a plain
  relaunch (no flags) has no extension in the profile at all.
- Legacy registry install (`HKCU\Software\Google\Chrome\Extensions\<id>` with
  `Path` → local `.crx`) is disallowed on Windows since **Chrome 33**
  (https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions).
- `ExtensionInstallForcelist` for non-Web-Store CRXs on Windows requires
  AD/Azure-AD join or Chrome Enterprise Core enrollment — unavailable here
  (https://chromium.googlesource.com/chromium/src/+/HEAD/components/policy/resources/templates/policy_definitions/Extensions/ExtensionInstallForcelist.yaml).
- Branded Chrome removed `--load-extension` in **137**
  (https://developer.chrome.com/blog/extension-news-june-2025/); CfT still has
  it, but post-startup either way.

**For real Store users none of this applies:** the extension is installed from
the Web Store *while Chrome runs*, so it is part of the profile at every
subsequent startup and `onStartup` is delivered by the platform. This drill is
exactly how we verify that last mile on an installed build.

## Files
- Marker: `public/background.js` → `chrome.runtime.onStartup` → `lastStartupCheck`
- Display: `src/popup/pages/Settings.jsx` → Recovery history → **Startup check**
- Related suites: `scripts/reliability.test.mjs` (A1–A3 detection logic),
  `crashux` run (banner/restore UX, 19/19), screenshots `ui/chrome-qa-03/04`
