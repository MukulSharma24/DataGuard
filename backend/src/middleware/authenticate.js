'use strict';

const jwt    = require('jsonwebtoken');
const logger = require('../utils/logger');

const COOKIE_NAME = 'dg_token';

/**
 * Reads a JWT from the httpOnly cookie (browser) or Authorization: Bearer header (API clients).
 * Attaches req.user = { id, email, role } on success.
 */
function authenticate(req, res, next) {
  const token =
    req.cookies?.[COOKIE_NAME] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '');

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired — please log in again' });
    }
    logger.warn('Invalid JWT rejected', { message: err.message });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Require a specific role. Must come after authenticate().
 * authorize('admin') — admin only
 * authorize('viewer') — viewer or admin
 */
function authorize(requiredRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (requiredRole === 'admin' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
