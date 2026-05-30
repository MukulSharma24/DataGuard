'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const Joi     = require('joi');
const { query } = require('../config/database');
const logger  = require('../utils/logger');

const router      = express.Router();
const COOKIE_NAME = 'dg_token';
const JWT_EXPIRY  = '8h';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRY, algorithm: 'HS256' }
  );
}

function setCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax', // 'none' required for cross-origin (Vercel → Render)
    secure:   isProd,                   // 'none' requires secure:true
    maxAge:   8 * 60 * 60 * 1000,
    path:     '/',
  });
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const schema = Joi.object({
    email:    Joi.string().email().required(),
    password: Joi.string().required(),
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { rows } = await query(
    `SELECT id, email, password_hash, role FROM users WHERE email = $1`,
    [value.email.toLowerCase()]
  );

  // Always run bcrypt to prevent user-enumeration via timing
  const dummyHash = '$2a$12$invalidhashinvalidhashinvalidhas';
  const valid = await bcrypt.compare(value.password, rows[0]?.password_hash ?? dummyHash);

  if (!rows.length || !valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const user  = rows[0];
  const token = signToken(user);
  setCookie(res, token);

  logger.info('User logged in', { email: user.email, role: user.role });
  res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

// POST /api/auth/logout
router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ message: 'Logged out' });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME]
    || req.headers['authorization']?.replace(/^Bearer\s+/i, '');

  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ user: { id: payload.sub, email: payload.email, role: payload.role } });
  } catch {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.status(401).json({ error: 'Session expired' });
  }
});

// POST /api/auth/register
// First user ever → automatically becomes admin (bootstrap).
// All subsequent registrations require an active admin session.
router.post('/register', async (req, res) => {
  const schema = Joi.object({
    email:    Joi.string().email().required(),
    password: Joi.string().min(8).required(),
    role:     Joi.string().valid('admin', 'viewer').default('viewer'),
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { rows: [{ count }] } = await query(`SELECT COUNT(*) AS count FROM users`);
  const isFirstUser = parseInt(count, 10) === 0;

  if (!isFirstUser) {
    const token = req.cookies?.[COOKIE_NAME]
      || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Admin authentication required' });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.role !== 'admin') {
        return res.status(403).json({ error: 'Admin role required to register users' });
      }
    } catch {
      return res.status(401).json({ error: 'Session expired' });
    }
  }

  const hash = await bcrypt.hash(value.password, 12);
  const role = isFirstUser ? 'admin' : value.role;

  try {
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)
       RETURNING id, email, role`,
      [value.email.toLowerCase(), hash, role]
    );
    logger.info('User registered', { email: rows[0].email, role: rows[0].role });
    res.status(201).json({ user: { id: rows[0].id, email: rows[0].email, role: rows[0].role } });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    throw err;
  }
});

module.exports = router;
