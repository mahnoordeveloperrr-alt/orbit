const express = require('express');
const crypto = require('crypto'); // 🔗 share tokens (B5)
const router = express.Router();
const Session = require('../models/Session');
const Tombstone = require('../models/Tombstone');
const User = require('../models/User');
const auth = require('../middleware/auth');

// 💰 FREE-TIER QUOTA (A2) — enforced HERE, on the server, mirroring the
//    Worker. The client never decides its own limit: an over-quota create is
//    an honest 402 (code 'quota-exceeded') the extension surfaces in the
//    sync status instead of a silent drop. Limit comes from ../plans.js so
//    the /api/me/plan answer and this check can never disagree.
const { tierFor } = require('../plans');
const SessionVersion = require('../models/SessionVersion');
const Share = require('../models/Share');
// 🔗 Share snapshots (B5) and version archives (B7) freeze the SAME
//    normalized shape — defined once in routes/shares.js.
const { snapshotOf } = require('./shares');

// 💰 Entitlement for ONE user — same lookup shape the Worker keeps in
//    planOf(): plan name + tier depths, read server-side, never trusted
//    from the client.
async function entitlementFor(userId) {
  const user = await User.findById(userId).select('plan').lean();
  const plan = (user && user.plan) || 'free';
  return { plan, ...tierFor(plan) };
}

// 🕘 VERSION ARCHIVE (B7) — snapshot the PREVIOUS state right before a
//    content write overwrites it, then prune to the tier's depth (3 free /
//    20 pro). Restoring a version is itself a write (bumps updatedAt), so
//    every other device LWW-adopts the restored content on its next sync.
async function archiveVersion(userId, doc, maxVersions) {
  if (!doc || !(maxVersions > 0)) return;
  const sessionId = String(doc._id);
  await SessionVersion.create({ userId, sessionId, snapshot: snapshotOf(doc) });
  const extras = await SessionVersion.find({ userId, sessionId })
    .sort({ createdAt: -1 }).skip(maxVersions).select('_id').lean();
  if (extras.length) {
    await SessionVersion.deleteMany({ _id: { $in: extras.map((e) => e._id) } });
  }
}

// 🧹 ORPHAN SWEEP (B5/B7) — versions/shares of rows that no longer exist
//    (purged or 30-day-expired) die with the session they point at.
async function sweepOrphans(userId) {
  const alive = await Session.find({ userId }).select('_id').lean();
  const ids = alive.map((a) => String(a._id));
  const gone = ids.length ? { $nin: ids } : null;
  if (gone) {
    await SessionVersion.deleteMany({ userId, sessionId: gone });
    await Share.deleteMany({ userId, sessionId: gone });
  } else {
    await SessionVersion.deleteMany({ userId });
    await Share.deleteMany({ userId });
  }
}

// 🔄 Tombstone helpers — soft-delete, purge and restore all funnel through
//    these so GET /tombstones can never drift from the trash state.
const markTombstone = (userId, sessionId, when) =>
  Tombstone.updateOne(
    { userId, sessionId },
    { $set: { deletedAt: when || new Date() } },
    { upsert: true }
  ).catch(() => {});
const clearTombstone = (userId, sessionId) =>
  Tombstone.deleteOne({ userId, sessionId }).catch(() => {});

// 🆕 SESSION SNAPSHOT v1 normalizer — mirrors src/services/sessionSchema.js.
// Converts ANY stored doc ({windows} or legacy {urls, groups[].urlIndices})
// into the locked v1 view. Returns null when nothing is restorable.
const VALID_STATES = new Set(['normal', 'minimized', 'maximized', 'fullscreen']);
const VALID_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
const safeIso = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

function normalizeToV1(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let windows = null;
  if (Array.isArray(raw.windows)) {
    windows = [];
    raw.windows.forEach(w => {
      if (!w || typeof w !== 'object') return;
      const tabs = (Array.isArray(w.tabs) ? w.tabs : [])
        .map(t => (t && typeof t === 'object' ? {
          url: String(t.url || '').trim(),
          title: String(t.title || ''),
          pinned: !!t.pinned,
          active: !!t.active,
          groupId: t.groupId != null && t.groupId !== '' ? String(t.groupId) : null
        } : null))
        .filter(t => t && t.url);
      if (tabs.length === 0) return;
      const groups = (Array.isArray(w.groups) ? w.groups : []).map((g, i) => ({
        id: g && g.id != null ? String(g.id) : `g${i + 1}`,
        title: String((g && g.title) || ''),
        color: VALID_COLORS.has(g && g.color) ? g.color : 'grey',
        collapsed: !!(g && g.collapsed)
      }));
      const referenced = new Set(tabs.map(t => t.groupId).filter(Boolean));
      windows.push({
        state: VALID_STATES.has(w.state) ? w.state : 'normal',
        focused: !!w.focused,
        tabs,
        groups: groups.filter(g => referenced.has(g.id))
      });
    });
  } else if (Array.isArray(raw.urls) && raw.urls.length > 0) {
    // Legacy → v1 (single window, membership via urlIndices)
    const legacyGroups = Array.isArray(raw.groups) ? raw.groups : [];
    const groups = [];
    const tabs = raw.urls.map((url, i) => {
      let groupId = null;
      const g = legacyGroups.find(gg => gg && Array.isArray(gg.urlIndices) && gg.urlIndices.includes(i));
      if (g) {
        if (!g._id) {
          g._id = `g${groups.length + 1}`;
          groups.push({
            id: g._id,
            title: String(g.title || ''),
            color: VALID_COLORS.has(g.color) ? g.color : 'grey',
            collapsed: !!g.collapsed
          });
        }
        groupId = g._id;
      }
      return { url: String(url).trim(), title: '', pinned: false, active: false, groupId };
    }).filter(t => t.url);
    if (tabs.length > 0) windows = [{ state: 'normal', focused: true, tabs, groups }];
  }
  if (!windows || windows.length === 0) return null;
  // 🆕 Metadata (V1.5): tags/note/folder — sanitized exactly like the popup
  //    normalizer so both devices agree on what a valid tag/note/folder is.
  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .filter(t => typeof t === 'string' && t.trim())
    .map(t => t.trim())
    .slice(0, 20);
  return {
    _id: raw._id,
    name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : 'Untitled session',
    schemaVersion: 1,
    windows,
    tags,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 500) : '',
    folder: (typeof raw.folder === 'string' && raw.folder.trim()) ? raw.folder.trim().slice(0, 50) : null,
    isAutoSave: !!raw.isAutoSave,
    autoKey: raw.autoKey ?? null,
    deletedAt: safeIso(raw.deletedAt),
    createdAt: safeIso(raw.createdAt),
    updatedAt: safeIso(raw.updatedAt) || safeIso(raw.createdAt)
  };
}

// Get all sessions (live only — trashed sessions are excluded)
router.get('/', auth, async (req, res) => {
  try {
    // 🆕 Auto-purge: trash items older than 30 days are gone for good
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await Session.deleteMany({ userId: req.user.id, deletedAt: { $ne: null, $lt: cutoff } });
    // Tombstones follow the same 30-day retention as the trash they mark
    await Tombstone.deleteMany({ userId: req.user.id, deletedAt: { $lt: cutoff } });
    await sweepOrphans(req.user.id);

    const sessions = await Session.find({ userId: req.user.id, deletedAt: null }).sort({ createdAt: -1 });
    // 🆕 Normalize legacy docs ({urls, groups[].urlIndices}) → v1 in the response
    //    AND lazily upgrade the stored doc (same normalize-on-read policy as the
    //    popup store).
    const out = [];
    for (const doc of sessions) {
      const norm = normalizeToV1(doc.toObject());
      if (!norm) continue;
      if (!doc.schemaVersion && !doc.windows) {
        doc.schemaVersion = 1;
        doc.windows = norm.windows;
        await doc.save().catch(() => {}); // best-effort lazy upgrade
        out.push({ ...doc.toObject(), windows: norm.windows });
      } else {
        out.push(norm);
      }
    }
    res.json(out);
  } catch (err) {
    console.error('❌ GET Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Save a session — accepts BOTH v1 ({ windows }) and legacy ({ urls, groups })
router.post('/', auth, async (req, res) => {
  try {
    const { name, windows, urls, groups, tags, note, folder } = req.body;

    // 💰 FREE-TIER QUOTA — server-side (B1: tier-driven, mirrors Worker).
    //    Live, non-autosave sessions count against the cap (Live Backup
    //    rides its own endpoint); Pro's tier is unlimited.
    const ent = await entitlementFor(req.user.id);
    if (ent.maxSyncedSessions >= 0) {
      const used = await Session.countDocuments({ userId: req.user.id, deletedAt: null, isAutoSave: false });
      if (used >= ent.maxSyncedSessions) {
        return res.status(402).json({
          error: `Plan limit reached — the ${ent.plan} plan syncs up to ${ent.maxSyncedSessions} sessions.`,
          code: 'quota-exceeded', plan: ent.plan, limit: ent.maxSyncedSessions,
        });
      }
    }

    console.log(`📦 Saving session for user: ${req.user.id}`); // Backend pe yeh print hoga

    const session = new Session({
      userId: req.user.id,
      name,
      windows: Array.isArray(windows) ? windows : null,
      schemaVersion: Array.isArray(windows) ? 1 : null,
      // 🆕 V1.5 metadata (optional — old clients never send it)
      tags: Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()).slice(0, 20) : [],
      note: typeof note === 'string' ? note.slice(0, 500) : '',
      folder: (typeof folder === 'string' && folder.trim()) ? folder.trim().slice(0, 50) : null,
      // Legacy fields only written when a legacy client posts { urls }
      urls: Array.isArray(urls) ? urls : [],
      groups: Array.isArray(groups) ? groups : [],
      updatedAt: new Date()
    });
    await session.save();
    
    console.log(`✅ Session saved successfully: ${session._id}`); // Save hone par yeh print
    res.json(session);
  } catch (err) {
    console.error('❌ Backend Error while saving:', err); // ERROR yahan print hoga
    res.status(500).json({ error: err.message });
  }
});
// 🆕 AUTO-SAVE (background service worker) — upsert ONE "Live Backup" session per user.
// Accepts v1 ({ windows }) from the current worker and legacy ({ urls, groups })
// from older workers, so a mid-upgrade sync never fails.
router.post('/autosave', auth, async (req, res) => {
  try {
    const { name, windows, urls, groups } = req.body;
    const autoKey = 'live-backup';

    let session = await Session.findOne({ userId: req.user.id, autoKey });
    if (session) {
      session.name = name || session.name;
      if (Array.isArray(windows)) {
        session.windows = windows;
        session.schemaVersion = 1;
        session.urls = [];
        session.groups = [];
      } else {
        session.urls = urls;
        session.groups = Array.isArray(groups) ? groups : [];
      }
      session.createdAt = new Date(); // keep it sorted to the top of the list
      session.updatedAt = new Date();
      await session.save();
    } else {
      session = await Session.create({
        userId: req.user.id,
        autoKey,
        isAutoSave: true,
        name: name || 'Auto-save — Live Backup',
        windows: Array.isArray(windows) ? windows : null,
        schemaVersion: Array.isArray(windows) ? 1 : null,
        urls: Array.isArray(urls) ? urls : [],
        groups: Array.isArray(groups) ? groups : []
      });
    }

    const tabCount = Array.isArray(windows)
      ? windows.reduce((n, w) => n + (w?.tabs?.length || 0), 0)
      : (urls?.length || 0);
    console.log(`♻️ Auto-save synced for user ${req.user.id} (${tabCount} tabs)`);
    res.json(session);
  } catch (err) {
    console.error('❌ Autosave Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🆕 UPDATE one session — full-library sync push (rename / edited content).
// Last-write-wins: the caller sends its updatedAt; if the server copy is
// NEWER, the server copy wins and we say so (no silent overwrite).
router.put('/:id', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ _id: req.params.id, userId: req.user.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const { name, windows, urls, groups, updatedAt, tags, note, folder } = req.body || {};
    const clientAt = updatedAt ? new Date(updatedAt) : null;
    if (clientAt && session.updatedAt && clientAt < new Date(session.updatedAt)) {
      return res.status(200).json({ message: 'server copy is newer — kept', conflict: 'server-newer', session });
    }
    // 🔄 A write to a TRASHED row: the client's stamp is >= the server copy
    // (soft-delete bumps updatedAt = deletedAt), so LWW says the newer edit
    // REVIVES the session — tombstone lifted with it.
    if (session.deletedAt) {
      if (clientAt && clientAt >= new Date(session.deletedAt)) {
        session.deletedAt = null;
        clearTombstone(req.user.id, String(session._id));
      } else {
        return res.status(200).json({ message: 'server copy is newer — kept', conflict: 'server-newer', session });
      }
    }
    // 🕘 B7 — archive the state we're about to overwrite (tier-pruned)
    {
      const ent = await entitlementFor(req.user.id);
      await archiveVersion(req.user.id, session, ent.maxVersions);
    }

    if (typeof name === 'string' && name.trim()) session.name = name.trim();
    if (Array.isArray(windows) && windows.length > 0) {
      session.windows = windows;
      session.schemaVersion = 1;
      session.urls = [];
      session.groups = [];
    } else if (Array.isArray(urls)) {
      session.urls = urls;
      session.groups = Array.isArray(groups) ? groups : [];
    }
    // 🆕 V1.5 metadata — present in the payload means "set it" (LWW already
    //    decided this copy is the newer one; missing fields keep old values).
    if (Array.isArray(tags)) session.tags = tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()).slice(0, 20);
    if (typeof note === 'string') session.note = note.slice(0, 500);
    if (folder !== undefined) session.folder = (typeof folder === 'string' && folder.trim()) ? folder.trim().slice(0, 50) : null;
    session.updatedAt = new Date();
    await session.save();
    console.log(`✏️ Session updated: ${session._id}`);
    res.json(session);
  } catch (err) {
    console.error('❌ Update Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🕘 GET /:id/versions — version history (B7). What's listed is exactly
// what exists: the tier depth is enforced by pruning at WRITE time.
router.get('/:id/versions', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ _id: req.params.id, userId: req.user.id }).select('_id').lean();
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const rows = await SessionVersion.find({ userId: req.user.id, sessionId: String(session._id) })
      .sort({ createdAt: -1 }).lean();
    res.json(rows.map((r) => {
      let snap = null;
      try { snap = JSON.parse(r.snapshot); } catch { snap = null; }
      const wins = snap && Array.isArray(snap.windows) ? snap.windows : [];
      const tabs = wins.reduce((n, w) => n + (Array.isArray(w && w.tabs) ? w.tabs.length : 0), 0)
        + (snap && Array.isArray(snap.urls) ? snap.urls.length : 0);
      return {
        _id: String(r._id),
        createdAt: new Date(r.createdAt).toISOString(),        name: (snap && snap.name) || 'Untitled session',

        windows: wins.length,
        tabs,
        updatedAt: (snap && snap.updatedAt) || null,
      };
    }));
  } catch (err) {
    console.error('❌ Versions GET Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🕘 POST /:id/versions/:vid/restore — apply an old state as the NEW
// current write: current state is archived first, updatedAt bumps, so
// every other device picks it up through the normal LWW path.
router.post('/:id/versions/:vid/restore', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ _id: req.params.id, userId: req.user.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    let ver = null;
    try {
      ver = await SessionVersion.findOne({ _id: req.params.vid, userId: req.user.id, sessionId: String(session._id) }).lean();
    } catch { ver = null; } // CastError on a garbage id → 404 below
    if (!ver) return res.status(404).json({ error: 'Version not found' });
    let snap = null;
    try { snap = JSON.parse(ver.snapshot); } catch { snap = null; }
    if (!snap) return res.status(500).json({ error: 'Version unreadable' });

    const ent = await entitlementFor(req.user.id);
    await archiveVersion(req.user.id, session, ent.maxVersions); // current state first
    const wins = snap.windows;
    session.name = (typeof snap.name === 'string' && snap.name.trim()) ? snap.name.trim() : session.name;
    if (Array.isArray(wins) && wins.length > 0) {
      session.windows = wins;
      session.schemaVersion = 1;
      session.urls = [];
      session.groups = [];
    } else {
      session.windows = null;
      session.schemaVersion = null;
      session.urls = Array.isArray(snap.urls) ? snap.urls : [];
      session.groups = Array.isArray(snap.groups) ? snap.groups : [];
    }
    session.tags = Array.isArray(snap.tags) ? snap.tags : [];
    session.note = typeof snap.note === 'string' ? snap.note.slice(0, 500) : '';
    session.folder = (typeof snap.folder === 'string' && snap.folder.trim()) ? snap.folder.trim().slice(0, 50) : null;
    session.updatedAt = new Date();
    await session.save();
    res.json(session);
  } catch (err) {
    console.error('❌ Version Restore Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🔗 POST /:id/share — mint a 30-day share link (B5). One live link per
// session: re-sharing rotates the token and kills the old link.
router.post('/:id/share', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ _id: req.params.id, userId: req.user.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.deletedAt) return res.status(400).json({ error: 'Sessions in trash cannot be shared' });

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await Share.deleteMany({ userId: req.user.id, sessionId: String(session._id) });
    await Share.create({
      token,
      userId: req.user.id,
      sessionId: String(session._id),
      snapshot: snapshotOf(session),
      expiresAt,
    });
    const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    res.json({
      token,
      url: base ? `${base}/dashboard.html?share=${token}` : null,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error('❌ Share Mint Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🆕 TRASH — list soft-deleted sessions (newest first)
router.get('/trash', auth, async (req, res) => {
  try {
    // Purge on sight: anything older than 30 days is gone for good
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await Session.deleteMany({ userId: req.user.id, deletedAt: { $ne: null, $lt: cutoff } });
    await sweepOrphans(req.user.id); // versions/shares of expired trash rows

    const sessions = await Session.find({ userId: req.user.id, deletedAt: { $ne: null } })
      .sort({ deletedAt: -1 });
    res.json(sessions);
  } catch (err) {
    console.error('❌ Trash GET Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🔄 GET /tombstones — DELETION PROPAGATION: ids deleted (trashed OR purged)
// that other devices still hold live copies of. Pruned with the 30-day trash
// retention like everything else on this route.
router.get('/tombstones', auth, async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await Tombstone.deleteMany({ userId: req.user.id, deletedAt: { $lt: cutoff } });
    const rows = await Tombstone.find({ userId: req.user.id }).sort({ deletedAt: -1 }).lean();
    res.json(rows.map(r => ({ _id: r.sessionId, deletedAt: new Date(r.deletedAt).toISOString() })));
  } catch (err) {
    console.error('❌ Tombstones GET Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🆕 RESTORE one session (Undo) — must be registered before any /:id catch-alls
router.post('/:id/restore', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ _id: req.params.id, userId: req.user.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.deletedAt) return res.json(session); // already live — idempotent

    // Restore is a WRITE: bump updatedAt (so other devices see it as newer
    // than the delete) and lift the tombstone so they un-trash their copies.
    session.deletedAt = null;
    session.updatedAt = new Date();
    await session.save();
    await clearTombstone(req.user.id, String(session._id));
    console.log(`↩️ Session restored: ${session._id}`);
    res.json(session);
  } catch (err) {
    console.error('❌ Restore Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🆕 RESTORE multiple sessions (Bulk Undo)
router.post('/restore/bulk', auth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No valid IDs provided' });
    }

    const result = await Session.updateMany(
      { _id: { $in: ids }, userId: req.user.id, deletedAt: { $ne: null } },
      { $set: { deletedAt: null, updatedAt: new Date() } } // write-stamp, like single restore
    );
    await Promise.all(ids.map(id => clearTombstone(req.user.id, String(id))));

    console.log(`↩️ Bulk restored ${result.modifiedCount} sessions for user ${req.user.id}`);
    res.json({ message: `${result.modifiedCount} sessions restored.`, restoredCount: result.modifiedCount });
  } catch (err) {
    console.error('❌ Bulk Restore Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🆕 EMPTY TRASH — permanently delete ALL trashed sessions of this user.
// Tombstones SURVIVE the rows: other devices must learn about purges too.
router.delete('/trash/purge', auth, async (req, res) => {
  try {
    const doomed = await Session.find({ userId: req.user.id, deletedAt: { $ne: null } }).select('deletedAt').lean();
    const result = await Session.deleteMany({ userId: req.user.id, deletedAt: { $ne: null } });
    await Promise.all(doomed.map(d => markTombstone(req.user.id, String(d._id), d.deletedAt || new Date())));
    await sweepOrphans(req.user.id); // history + share links die with the rows
    console.log(`🗑️🗑️ Trash purged: ${result.deletedCount} sessions for user ${req.user.id}`);
    res.json({ message: `${result.deletedCount} sessions permanently deleted.` });
  } catch (err) {
    console.error('❌ Trash Purge Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🆕 DELETE multiple sessions (Bulk Delete) → SOFT delete, undoable
// ⚠️ MUST be registered BEFORE DELETE /:id — otherwise "bulk" is captured as an :id (CastError)
router.delete('/bulk', auth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No valid IDs provided' });
    }

    // Security: Ensure user owns ALL these sessions (userId in the filter)
    const now = new Date();
    const doomed = await Session.find({ _id: { $in: ids }, userId: req.user.id, deletedAt: null }).select('_id').lean();
    const result = await Session.updateMany(
      { _id: { $in: ids }, userId: req.user.id, deletedAt: null },
      { $set: { deletedAt: now, updatedAt: now } } // a delete IS a write (LWW)
    );
    await Promise.all(doomed.map(d => markTombstone(req.user.id, String(d._id), now)));

    console.log(`🗑️ Bulk trashed ${result.modifiedCount} sessions for user ${req.user.id}`);
    res.json({ message: `${result.modifiedCount} sessions deleted (undoable).`, deletedCount: result.modifiedCount });
  } catch (err) {
    console.error('❌ Bulk Delete Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🆕 DELETE one session → SOFT delete (goes to trash, undoable for 30 days)
router.delete('/:id', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ _id: req.params.id, userId: req.user.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // A delete IS a write: bump updatedAt (delete time outranks older edits)
    // and leave a tombstone for every other device.
    const when = new Date();
    session.deletedAt = when;
    session.updatedAt = when;
    await session.save();
    await markTombstone(req.user.id, String(session._id), when);
    console.log(`🗑️ Session moved to trash: ${session._id}`);
    res.json({ message: 'Session deleted (undoable)', session });
  } catch (err) {
    console.error('❌ Delete Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🆕 PERMANENTLY delete one trashed session (no undo)
router.delete('/:id/purge', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ _id: req.params.id, userId: req.user.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.deletedAt) {
      return res.status(400).json({ error: 'Session is not in trash' });
    }

    // Tombstone keeps the ORIGINAL delete stamp (LWW + retention clock) so
    // purging the row doesn't erase what other devices are owed.
    await markTombstone(req.user.id, String(session._id), session.deletedAt);
    await session.deleteOne();
    // history + share links of a purged session die with it
    await SessionVersion.deleteMany({ userId: req.user.id, sessionId: String(session._id) });
    await Share.deleteMany({ userId: req.user.id, sessionId: String(session._id) });
    console.log(`🗑️ Session permanently deleted: ${session._id}`);
    res.json({ message: 'Session permanently deleted' });
  } catch (err) {
    console.error('❌ Purge Error:', err);
    res.status(500).json({ error: err.message });
  }
});
// Exposed for tests/dev tooling — the popup keeps its own ESM copy
// (src/services/sessionSchema.js) because they must stay in sync.
router.normalizeToV1 = normalizeToV1;

module.exports = router;