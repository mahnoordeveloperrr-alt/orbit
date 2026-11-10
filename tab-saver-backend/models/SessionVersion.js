const mongoose = require('mongoose');

// 🕘 VERSION HISTORY (mirror of cloud-api session_versions table).
// One row = the snapshot of a session's PREVIOUS state, archived right
// before a content write overwrote it. Depth is enforced by pruning at
// write time (tierFor(plan).maxVersions — 3 free / 20 pro), so what the
// API lists is exactly what exists. `snapshot` is a JSON string — restoring
// one is itself a write (bumps updatedAt → other devices LWW-adopt it).
const SessionVersionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: String, required: true },
  snapshot: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

SessionVersionSchema.index({ userId: 1, sessionId: 1, createdAt: -1 });

module.exports = mongoose.model('SessionVersion', SessionVersionSchema);
