const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isVerified: { type: Boolean, default: false },          // ✅ Email verify hua ya nahi
  verificationToken: { type: String },
  verificationTokenExpires: { type: Date },
  // 🆕 Password recovery — single-use token, 30-minute window (P0 account
  //    lifecycle: forgot/reset password was the one missing flow).
  resetToken: { type: String },
  resetTokenExpires: { type: Date },
  // 💰 ENTITLEMENT (A2) — server-side plan, default 'free'. Enforced in
  //    routes/sessions.js (never trusted from the client); billing flips it
  //    to 'pro' later. Sessions-per-plan lives in routes/plan.js constants.
  plan: { type: String, enum: ['free', 'pro'], default: 'free' },
});

UserSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

UserSchema.methods.matchPassword = async function(password) {
  return await bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', UserSchema);