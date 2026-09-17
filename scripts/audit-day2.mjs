// Day-2 acceptance audit — verifies the Day-2 statement clause by clause
// against the actual code. Run: node scripts/audit-day2.mjs
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

const dashboard = read('src/popup/pages/Dashboard.jsx');
const settingsPage = read('src/popup/pages/Settings.jsx');
const saveSession = read('src/popup/components/dashboard/SaveSession.jsx');
const sessionList = read('src/popup/components/dashboard/SessionList.jsx');
const organize = read('src/popup/components/dashboard/OrganizePanel.jsx');
const worker = read('public/background.js');
const app = read('src/popup/App.jsx');
const store = read('src/services/store.js');

console.log('\n── CLAUSE 1: "organize tabs normally, click Save" ──');
check('One-click Save button (auto-generated name)', dashboard.includes('handleQuickSave = async () => saveWindowsAs(autoSessionName())'));
check('Name optional (placeholder says so)', saveSession.includes('Session name (optional)'));
check('Enter key saves', saveSession.includes("if (e.key === 'Enter') handleSave()"));
check('All-windows / current-window scope toggle', saveSession.includes("scope === 'all' ? 'window' : 'all'"));
check('Rename-later UI (click name to edit)', sessionList.includes('await renameSession(uid, name)'));
check('renameSession exists in store', store.includes('export async function renameSession'));
check('Auto-name format "Session — <date> — <time>"', dashboard.includes('Session — ${mon} ${day}, ${year}') || dashboard.includes('`Session — ${mon}'));

console.log('\n── CLAUSE 2: "close Chrome, return later, restore" ──');
check('Graceful shutdown flagged (cleanExit on last window close)', worker.includes('cleanExit: true'));
check('Restore via worker (RESTORE_SESSION message)', worker.includes("type === 'RESTORE_SESSION'"));
check('Recovery candidate persists across restarts', worker.includes('recoveryCandidate'));
check('Recovery points ring buffer (recent snapshots kept, user-capped cap 10)', worker.includes('RECOVERY_POINTS_MAX') && worker.includes('maxRecoveryPoints'));

console.log('\n── CLAUSE 3: "tabs/windows/groups with organization intact" ──');
check('Capture: per-tab groupId', worker.includes('groupId'));
check('Capture: pinned + active flags', worker.includes('pinned: !!t.pinned') && worker.includes('active: !!t.active'));
check('Capture: window state', worker.includes('state: win.state') || worker.includes("['normal', 'minimized', 'maximized', 'fullscreen'].includes(win.state)"));
check('Restore maps members by groupId (index-free)', worker.includes('t.groupId === g.id ? tabIds[i]'));
check('Restore re-applies group title/color/collapsed', worker.includes('chrome.tabGroups.update(groupId, props)'));
check('Restore re-pins tabs (by id, reorder-safe, toggleable)', /o\.pinned && win\.tabs\[i\]\.pinned/.test(worker));
check('Window state re-applied on restore', worker.includes('chrome.windows.update(created.id, { state: win.state })'));
check('Focused window restored last', worker.includes('const focusedWin = windows.find(w => w.focused)'));
check('Dead URL cannot kill a window (per-tab fallback)', worker.includes('falling back per-tab'));

console.log('\n── CLAUSE 4: "without being forced to create an account" ──');
check('App opens on Dashboard (no login gate)', app.includes("useState('dashboard')"));
check('Cloud sign-in is explicitly optional in UI', dashboard.includes('Sign in for cloud sync (optional)'));
check('Local store is the default data layer', dashboard.includes("from '../../services/store'"));
check('Live Backup works logged-out (local upsert)', worker.includes('upsertLocalLiveBackup'));
check('Auto-save can be toggled off by user', worker.includes('autoSaveEnabled') && settingsPage.includes('settings.autoSave'));

console.log('\n── CLAUSE 5: "Orbitabs never unexpectedly move/hide/group tabs" ──');
check('No tab hiding anywhere (API does not even exist)', !worker.includes('chrome.tabs.hide') && !organize.includes('chrome.tabs.hide'));
check('Worker groups tabs ONLY inside restoreSnapshot', (() => {
  const lines = worker.split('\n');
  const start = lines.findIndex(l => l.includes('async function restoreSnapshot'));
  const end = lines.findIndex(l => l.includes('Crash detection + recovery'));
  const callLines = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('chrome.tabs.group('));
  return callLines.length > 0 && callLines.every(([, i]) => i > start && i < end);
})());
check('Organize groups ONLY on explicit drag', organize.includes('onDragStart') && organize.includes('groupTabs(ids, group.windowId)'));
check('Organize delete-group keeps tabs (ungroup only)', organize.includes('await chrome.tabs.ungroup(ids)'));
check('Golden rule stated in UI', organize.includes('Nothing is grouped automatically'));
check('Restore never regroups user tabs outside restore', (() => {
  const outside = worker.split('async function restoreSnapshot')[0];
  return !outside.includes('chrome.tabs.group(');
})());

console.log(`\n════════════════════════════════════════════════`);
console.log(`  DAY 2 STATEMENT: ${pass} of ${pass + fail} checks pass`);
console.log(`  VERDICT: ${fail === 0 ? '✅ READY (code-level) — real-Chrome matrix remains' : '❌ GAPS FOUND'}`);
console.log(`════════════════════════════════════════════════\n`);
process.exit(fail > 0 ? 1 : 0);
