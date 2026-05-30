'use strict';

/**
 * API key authentication middleware.
 *
 * Protects all /api/* routes. Expects the key in:
 *   Header: x-api-key: <key>
 *
 * If API_KEY is not set in the environment the middleware is skipped entirely
 * so local development without a key still works.
 */
function apiKeyAuth(req, res, next) {
  const expectedKey = process.env.API_KEY;

  // Auth disabled — no key configured (local dev without .env setup)
  if (!expectedKey) return next();

  const providedKey = req.headers['x-api-key'];

  if (!providedKey) {
    return res.status(401).json({
      error: 'Missing API key. Provide x-api-key header.',
    });
  }

  // Constant-time comparison to prevent timing attacks
  const crypto = require('crypto');
  const expected = Buffer.from(expectedKey);
  const provided = Buffer.from(String(providedKey));

  if (
    expected.length !== provided.length ||
    !crypto.timingSafeEqual(expected, provided)
  ) {
    return res.status(403).json({ error: 'Invalid API key.' });
  }

  next();
}

module.exports = apiKeyAuth;
