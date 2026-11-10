const mongoose = require('mongoose');

// 🔗 SHARED SESSIONS (mirror of cloud-api shares table).
// A share freezes the session's snapshot at mint time and hands out an
// opaque 30-day token. Claiming copies the SNAPSHOT into the claimer's
// library — it never touches the sharer's session, and neither side ever
// sees the other's email. One live link per session (re-share rotates).
const ShareSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: String, required: true },
  snapshot: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

ShareSchema.index({ userId: 1, sessionId: 1 });

module.exports = mongoose.model('Share', ShareSchema);
