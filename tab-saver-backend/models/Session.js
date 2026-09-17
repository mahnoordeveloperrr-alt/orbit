const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  // 🆕 Session Snapshot v1 (LOCKED) — windows[] → tabs[{url,title,pinned,active,groupId}]
  //    + groups[{id,title,color,collapsed}]. Membership = tab.groupId === group.id.
  //    Legacy docs ({urls, groups[].urlIndices}) are normalized on read (popup
  //    sessionSchema.js) and lazily upgraded to v1 when a doc is rewritten.
  windows: { type: Array, default: null },
  schemaVersion: { type: Number, default: null },
  // LEGACY — kept only so old docs still load; new writes use `windows`
  urls: [{ type: String }],
  groups: [{
    title: { type: String, default: '' },
    color: { type: String, default: 'grey' },
    collapsed: { type: Boolean, default: false },
    urlIndices: [{ type: Number }]
  }],
  // 🆕 Auto-save (background service worker) — one upserted "Live Backup" per user
  isAutoSave: { type: Boolean, default: false },
  autoKey: { type: String, default: null },
  // 🆕 Soft delete (Trash + Undo): null = live, Date = moved to trash
  deletedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});


module.exports = mongoose.model('Session', SessionSchema);