'use strict';

/**
 * Thin Redis cache wrapper — all methods are no-ops when Redis is unavailable.
 * Uses the same IORedis connection as the job queue to avoid extra connections.
 */

const { getConnection } = require('../queue/index');
const logger = require('./logger');

async function cacheGet(key) {
  const conn = getConnection();
  if (!conn) return null;
  try {
    const raw = await conn.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn('Cache GET failed', { key, message: err.message });
    return null;
  }
}

async function cacheSet(key, value, ttlSeconds = 60) {
  const conn = getConnection();
  if (!conn) return;
  try {
    await conn.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('Cache SET failed', { key, message: err.message });
  }
}

async function cacheDel(...keys) {
  const conn = getConnection();
  if (!conn || !keys.length) return;
  try {
    await conn.del(...keys);
  } catch (err) {
    logger.warn('Cache DEL failed', { keys, message: err.message });
  }
}

module.exports = { cacheGet, cacheSet, cacheDel };
