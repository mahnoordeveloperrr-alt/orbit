const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const Session = require('../models/Session');
const SessionVersion = require('../models/SessionVersion');
const Share = require('../models/Share');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { planFor, tierFor } = require('../plans');

/* 🔗 SHARED SESSIONS (B5) — mirror of the Worker /api/shares routes.
   GET /:token previews (name/windows/tabs — never the owner's email),
   POST /:token claims the frozen snapshot into the caller's library with
   the SAME quota gate + dedupe rule as file import. The sharer's session
   is never mutated, and both sides stay anonymous to each other. */

const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const snapshotOf = (doc) => JSON.stringify({
  name: doc.name,
  windows: doc.windows || null,
  urls: doc.urls || [],
  groups: (doc.groups || []).map(g => ({ title: g.title, color: g.color, collapsed: g.collapsed, urlIndices: g.urlIndices })),
  tags: doc.tags || [],
  note: doc.note || '',
  folder: doc.folder || null,
  createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
});

router.get('/:token', auth, async (req, res) => {
  try {
    const share = await Share.findOne({ token: req.params.token, expiresAt: { $gt: new Date() } }).lean();
    if (!share) return res.status(404).json({ error: 'Share link is invalid or expired' });
    let snap = null;
    try { snap = JSON.parse(share.snapshot); } catch { snap = null; }
    if (!snap) return res.status(500).json({ error: 'Share link is invalid' });

    const wins = Array.isArray(snap.windows) ? snap.windows : [];
    const tabs = wins.reduce((n, w) => n + (Array.isArray(w && w.tabs) ? w.tabs.length : 0), 0)
      + (Array.isArray(snap.urls) ? snap.urls.length : 0);
    res.json({
      name: snap.name || 'Shared session',
      windows: wins.length,
      tabs,
      tags: Array.isArray(snap.tags) ? snap.tags : [],
      note: snap.note || '',
      folder: snap.folder || null,
      expiresAt: new Date(share.expiresAt).toISOString(),
    });
  } catch (err) {
    console.error('❌ Share GET Error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:token', auth, async (req, res) => {
  try {
    const share = await Share.findOne({ token: req.params.token, expiresAt: { $gt: new Date() } }).lean();
    if (!share) return res.status(404).json({ error: 'Share link is invalid or expired' });
    let snap = null;
    try { snap = JSON.parse(share.snapshot); } catch { snap = null; }
    if (!snap) return res.status(500).json({ error: 'Share link is invalid' });

    // Dedupe by name+createdAt against the caller's LIVE library — the same
    // rule as file import, so re-claiming never piles up copies. Both sides
    // normalize through new Date() so storage formats can't drift.
    const snapCreated = (snap.createdAt && !isNaN(new Date(snap.createdAt)))
      ? new Date(snap.createdAt).toISOString() : null;
    const sig = JSON.stringify([snap.name || null, snapCreated]);
    const mine = await Session.find({ userId: req.user.id, deletedAt: null, isAutoSave: false })
      .select('name createdAt').lean();
    const dup = mine.find((s) => JSON.stringify([s.name, new Date(s.createdAt).toISOString()]) === sig);
    if (dup) return res.json({ deduped: true, sessionId: String(dup._id), message: 'You already have this session' });

    // Quota gate — identical to POST /api/sessions (the claim IS a create)
    const user = await User.findById(req.user.id).select('plan').lean();
    const plan = (user && user.plan) || 'free';
    const limit = tierFor(plan).maxSyncedSessions;
    if (limit >= 0 && mine.length >= limit) {
      return res.status(402).json({
        error: `Plan limit reached — the ${plan} plan syncs up to ${limit} sessions.`,
        code: 'quota-exceeded', plan, limit,
      });
    }

    const wins = Array.isArray(snap.windows) && snap.windows.length ? snap.windows : null;
    const created = await Session.create({
      userId: req.user.id,
      name: snap.name || 'Shared session',
      windows: wins,
      schemaVersion: wins ? 1 : null,
      urls: wins ? [] : (Array.isArray(snap.urls) ? snap.urls : []),
      groups: wins ? [] : (Array.isArray(snap.groups) ? snap.groups : []),
      tags: Array.isArray(snap.tags) ? snap.tags : [],
      note: typeof snap.note === 'string' ? snap.note.slice(0, 500) : '',
      folder: (typeof snap.folder === 'string' && snap.folder.trim()) ? snap.folder.trim().slice(0, 50) : null,
      createdAt: snap.createdAt && !isNaN(new Date(snap.createdAt)) ? new Date(snap.createdAt) : new Date(),
      updatedAt: snap.updatedAt && !isNaN(new Date(snap.updatedAt)) ? new Date(snap.updatedAt) : new Date(),
    });
    res.json({ deduped: false, sessionId: String(created._id), session: created });
  } catch (err) {
    console.error('❌ Share Claim Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.SNAPSHOT_TTL = SHARE_TTL_MS; // exported for tests/dev tooling
module.exports.snapshotOf = snapshotOf;      // shares + version archive share this shape
