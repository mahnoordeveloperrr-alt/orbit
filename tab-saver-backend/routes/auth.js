const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Session = require('../models/Session');
const RefreshToken = require('../models/RefreshToken');
const Tombstone = require('../models/Tombstone');
const SessionVersion = require('../models/SessionVersion');
const Share = require('../models/Share');
const auth = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// 🔑 Refresh tokens are stored hashed (SHA-256) — a DB dump never yields a
//    usable token. Same helper shape the Worker uses (sha256Hex).
const sha256Hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Nodemailer setup
// Nodemailer setup (Email bhejne ke liye)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false // ✅ YEH LINE FIX KAR DEGI
  }
});

// ---------------------------------------------------------
// REGISTER (Email bhejein, login na karwayein)
// ---------------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ error: 'Email already registered' });

    const token = crypto.randomBytes(32).toString('hex');
    const tokenExpires = Date.now() + 3600000; // 1 hour

    user = new User({
      name, email, password,
      isVerified: false,
      verificationToken: token,
      verificationTokenExpires: tokenExpires
    });
    await user.save();

    // Email bhejo
    // APP_BASE_URL = public base (production deploy); localhost fallback for dev
    const verifyUrl = `${String(process.env.APP_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '')}/api/auth/verify/${token}`;
    await transporter.sendMail({
      from: `"Orbitabs" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Verify your Orbitabs account',
      html: `
        <div style="font-family: Inter, sans-serif; max-width: 500px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
          <h2 style="color: #4f46e5;">Welcome to Orbitabs! 🚀</h2>
          <p>Click the button below to verify your email and start saving your sessions.</p>
          <a href="${verifyUrl}" style="background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; margin: 10px 0;">Verify Email</a>
          <p style="color: #64748b; font-size: 12px;">If you didn't register, ignore this email.</p>
        </div>
      `
    });

    // ⚠️ Token nahi bhej rahe! User ko verify karna hoga.
    res.json({ message: 'Registration successful! Please check your email (orbitabsnoreply@gmail.com) to verify.', needsVerification: true });

  } catch (err) {
    console.error('Register Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------
// VERIFY (Link par click karne par)
// ---------------------------------------------------------
router.get('/verify/:token', async (req, res) => {
  const { token } = req.params;
  const user = await User.findOne({
    verificationToken: token,
    verificationTokenExpires: { $gt: Date.now() }
  });

  if (!user) return res.status(400).send('<h3 style="color:red;">Invalid or expired link</h3>');

  user.isVerified = true;
  user.verificationToken = undefined;
  user.verificationTokenExpires = undefined;
  await user.save();

  res.send(`
    <div style="font-family: Inter; text-align: center; padding: 50px;">
      <h2 style="color: #4f46e5;">✅ Email Verified!</h2>
      <p>You can now close this tab and login to your Orbitabs extension.</p>
    </div>
  `);
});

// ---------------------------------------------------------
// LOGIN (Sirf verified users)
// ---------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    if (!user.isVerified) {
      return res.status(403).json({ error: 'Email not verified! Check your inbox (orbitabsnoreply@gmail.com).' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

    const jwtToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    // 🔑 Sliding session: rotating refresh token per device (30d), stored
    //    hashed. The extension refreshes silently when the 7d JWT expires
    //    instead of kicking the user out to the sign-in screen.
    const refreshToken = crypto.randomBytes(32).toString('hex');
    await RefreshToken.create({
      tokenHash: sha256Hex(refreshToken),
      userId: user._id,
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    res.json({
      token: jwtToken, refreshToken,
      user: { id: user._id, name: user.name, email: user.email },
    });

  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------
// REFRESH — exchange a refresh token for a NEW access JWT + a NEW refresh
// token (rotation: the presented token is spent; a replay = 401). One row
// per device, so logging in on a second device never kicks the first one.
// ---------------------------------------------------------
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({ error: 'Refresh token required' });
    }
    const tokenHash = sha256Hex(refreshToken);
    const row = await RefreshToken.findOne({ tokenHash, expires: { $gt: new Date() } });
    if (!row) return res.status(401).json({ error: 'Refresh token is not valid' });

    const nextRt = crypto.randomBytes(32).toString('hex');
    await RefreshToken.deleteOne({ tokenHash }); // rotation: this one is spent
    await RefreshToken.create({
      tokenHash: sha256Hex(nextRt),
      userId: row.userId,
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const token = jwt.sign({ id: row.userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, refreshToken: nextRt });
  } catch (err) {
    console.error('Refresh Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------
// LOGOUT — best-effort: spends THIS device's refresh token so a stolen copy
// dies with the session. Local sign-out works without reaching here.
// ---------------------------------------------------------
router.post('/logout', auth, async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (refreshToken) {
      await RefreshToken.deleteOne({ tokenHash: sha256Hex(String(refreshToken)), userId: req.user.id });
    }
    res.json({ message: 'Signed out' });
  } catch (err) {
    console.error('Logout Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------
// FORGOT PASSWORD — email a single-use reset link (30 min window).
// Always answers the SAME generic message whether or not the email exists
// (no account enumeration). The reset page (GET /reset-password/:token)
// serves a small HTML form; POST applies the new password.
// ---------------------------------------------------------
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    const generic = { message: 'If that email has an account, a reset link is on its way.' };
    if (!email || typeof email !== 'string') return res.json(generic);

    const user = await User.findOne({ email }); // same lookup as /login (case as registered)
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      user.resetToken = token;
      user.resetTokenExpires = Date.now() + 30 * 60 * 1000; // 30 minutes
      await user.save();

      const resetUrl = `${String(process.env.APP_BASE_URL || 'http://localhost:5000').replace(/\/+$/, '')}/api/auth/reset-password/${token}`;
      try {
        await transporter.sendMail({
          from: `"Orbitabs" <${process.env.EMAIL_USER}>`,
          to: user.email,
          subject: 'Reset your Orbitabs password',
          html: `
            <div style="font-family: Inter, sans-serif; max-width: 500px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
              <h2 style="color: #4f46e5;">Password reset 🔑</h2>
              <p>Click the button below to choose a new password. The link expires in 30 minutes and can be used once.</p>
              <a href="${resetUrl}" style="background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; margin: 10px 0;">Reset Password</a>
              <p style="color: #64748b; font-size: 12px;">If you didn't request this, ignore this email — your password stays unchanged.</p>
            </div>
          `
        });
      } catch (mailErr) {
        // Mail failure must not leak whether the account exists — log server-side only.
        console.error('Reset email failed:', mailErr.message);
      }
    }
    res.json(generic);
  } catch (err) {
    console.error('Forgot Password Error:', err);
    res.status(500).json({ error: 'Could not process the request — try again later.' });
  }
});

// Reset page (link target) — tiny HTML form that POSTs the new password.
router.get('/reset-password/:token', async (req, res) => {
  const user = await User.findOne({ resetToken: req.params.token, resetTokenExpires: { $gt: Date.now() } });
  if (!user) return res.status(400).send('<h3 style="color:red;">Invalid or expired reset link</h3>');
  res.send(`
    <div style="font-family: Inter; text-align:center; padding:50px;">
      <h2 style="color:#4f46e5;">Choose a new password</h2>
      <form method="POST" action="/api/auth/reset-password/${req.params.token}" style="display:inline-block; text:left;">
        <input name="password" type="password" required minlength="8" placeholder="New password" style="padding:10px; border:1px solid #cbd5e1; border-radius:8px; width:240px;" />
        <br/><br/>
        <button type="submit" style="background:#4f46e5; color:white; padding:10px 24px; border-radius:8px; border:0;">Set new password</button>
      </form>
    </div>
  `);
});

// POST from the reset form (HTML form post — urlencoded body)
router.post('/reset-password/:token', async (req, res) => {
  const wantsJson = String(req.headers.accept || '').includes('json') || req.is('json');
  const fail = (status, msg) => (wantsJson ? res.status(status).json({ error: msg }) : res.status(status).send(`<h3 style="color:red;">${msg}</h3>`));
  try {
    const password = (req.body?.password || '').trim();
    if (password.length < 8) return fail(400, 'Password must be at least 8 characters');

    const user = await User.findOne({ resetToken: req.params.token, resetTokenExpires: { $gt: Date.now() } });
    if (!user) return fail(400, 'Invalid or expired reset link');

    user.password = password; // bcrypt pre-save hook re-hashes
    user.resetToken = undefined;
    user.resetTokenExpires = undefined;
    await user.save();

    if (wantsJson) return res.json({ message: 'Password updated — sign in with your new password.' });
    res.send(`
      <div style="font-family: Inter; text-align:center; padding:50px;">
        <h2 style="color:#16a34a;">✅ Password updated</h2>
        <p>You can now close this tab and sign in to Orbitabs with your new password.</p>
      </div>
    `);
  } catch (err) {
    console.error('Reset Password Error:', err);
    fail(500, 'Could not reset the password — try again later.');
  }
});

// ---------------------------------------------------------
// DELETE ACCOUNT — privacy-policy / store-policy "delete my data".
// Password re-entry required; wipes the user AND every cloud session they
// own. Local extension data lives in Chrome and is never touched here.
// ---------------------------------------------------------
router.delete('/account', auth, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ error: 'Password confirmation required to delete the account' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });

    const ok = await user.matchPassword(password);
    if (!ok) {
      return res.status(401).json({ error: 'Incorrect password — account NOT deleted' });
    }

    await Session.deleteMany({ userId: req.user.id }); // all cloud sessions
    // "Account and all cloud data" includes the bookkeeping tables too:
    // tombstones (deletion marks), refresh tokens (device sessions), version
    // history snapshots and share links.
    await Tombstone.deleteMany({ userId: req.user.id });
    await RefreshToken.deleteMany({ userId: req.user.id });
    await SessionVersion.deleteMany({ userId: req.user.id });
    await Share.deleteMany({ userId: req.user.id });
    await user.deleteOne();
    console.log(`🔥 Account deleted (user ${req.user.id}) — cloud data wiped`);
    res.json({ message: 'Account and all cloud data permanently deleted' });
  } catch (err) {
    console.error('Account Delete Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;