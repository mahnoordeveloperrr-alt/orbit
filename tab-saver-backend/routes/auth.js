const express = require('express');
const router = express.Router();
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

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
    const verifyUrl = `http://localhost:5000/api/auth/verify/${token}`;
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
    res.json({ token: jwtToken, user: { id: user._id, name: user.name, email: user.email } });

  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;