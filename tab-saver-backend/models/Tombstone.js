const mongoose = require('mongoose');

// 🔄 DELETION PROPAGATION (mirror of cloud-api tombstones table).
// A tombstone MARKS a session id as deleted and SURVIVES the row it marks —
// permanent purge deletes the Session doc, but this row is what tells every
// other device "this one is gone, trash your copy". Restoring a session
// removes its tombstone (and bumps updatedAt) so the others un-trash again.
// Retention: pruned with the same 30-day window as the trash.
const TombstoneSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: String, required: true },
  deletedAt: { type: Date, required: true },
});

// One tombstone per user+session; re-delete just refreshes the stamp.
TombstoneSchema.index({ userId: 1, sessionId: 1 }, { unique: true });
TombstoneSchema.index({ userId: 1, deletedAt: 1 });

module.exports = mongoose.model('Tombstone', TombstoneSchema);
