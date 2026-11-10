const mongoose = require('mongoose');

// 🔑 SLIDING SESSION (mirror of cloud-api refresh_tokens table).
// One rotating refresh token per device: issued at login, replaced on every
// /refresh call (rotation → replay of a spent token = 401), removed at
// logout. Stored HASHED (SHA-256) so a DB dump never yields usable tokens.
const RefreshTokenSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expires: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

RefreshTokenSchema.index({ userId: 1 });
RefreshTokenSchema.index({ expires: 1 }, { expireAfterSeconds: 0 }); // Mongo prunes the dead ones

module.exports = mongoose.model('RefreshToken', RefreshTokenSchema);
