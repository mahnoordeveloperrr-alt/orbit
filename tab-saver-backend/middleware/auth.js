const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token, authorization denied' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // A JWT stays cryptographically valid for 7d even after the account is
    // deleted — confirm the account still exists so a deleted user can never
    // keep reading or writing (no orphan sessions). Invalid ids → null → 401.
    const stillExists = await User.exists({ _id: decoded.id }).catch(() => null);
    if (!stillExists) {
      return res.status(401).json({ error: 'Account no longer exists — sign in again' });
    }
    req.user = decoded; // user ka id req.user.id mein aa jayega
    next(); // ✅ YEH LINE ZAROORI HAI! Request aage badh jayegi
  } catch (err) {
    res.status(401).json({ error: 'Token is not valid' });
  }
};
