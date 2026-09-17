const express = require('express');
const router = express.Router();
const Session = require('../models/Session');
const auth = require('../middleware/auth');

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
  return {
    _id: raw._id,
    name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : 'Untitled session',
    schemaVersion: 1,
    windows,
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
    const { name, windows, urls, groups } = req.body;
    console.log(`📦 Saving session for user: ${req.user.id}`); // Backend pe yeh print hoga

    const session = new Session({
      userId: req.user.id,
      name,
      windows: Array.isArray(windows) ? windows : null,
      schemaVersion: Array.isArray(windows) ? 1 : null,
      // Legacy fields only written when a legacy client posts { urls }
      urls: Array.isArray(urls) ? urls : [],
      groups: Array.isArray(groups) ? groups : []
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

// 🆕 TRASH — list soft-deleted sessions (newest first)
router.get('/trash', auth, async (req, res) => {
  try {
    // Purge on sight: anything older than 30 days is gone for good
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await Session.deleteMany({ userId: req.user.id, deletedAt: { $ne: null, $lt: cutoff } });

    const sessions = await Session.find({ userId: req.user.id, deletedAt: { $ne: null } })
      .sort({ deletedAt: -1 });
    res.json(sessions);
  } catch (err) {
    console.error('❌ Trash GET Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🆕 RESTORE one session (Undo) — must be registered before any /:id catch-alls
router.post('/:id/restore', auth, async (req, res) => {
  try {
    const session = await Session.findOne({ _id: req.params.id, userId: req.user.id });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.deletedAt) return res.json(session); // already live — idempotent

    session.deletedAt = null;
    await session.save();
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
      { $set: { deletedAt: null } }
    );

    console.log(`↩️ Bulk restored ${result.modifiedCount} sessions for user ${req.user.id}`);
    res.json({ message: `${result.modifiedCount} sessions restored.`, restoredCount: result.modifiedCount });
  } catch (err) {
    console.error('❌ Bulk Restore Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🆕 EMPTY TRASH — permanently delete ALL trashed sessions of this user
router.delete('/trash/purge', auth, async (req, res) => {
  try {
    const result = await Session.deleteMany({ userId: req.user.id, deletedAt: { $ne: null } });
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
    const result = await Session.updateMany(
      { _id: { $in: ids }, userId: req.user.id, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );

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

    session.deletedAt = new Date();
    await session.save();
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

    await session.deleteOne();
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