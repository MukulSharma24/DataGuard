'use strict';

const { Pool } = require('pg');
const logger = require('../utils/logger');

let pool;

function getPool() {
  if (!pool) {
    const ssl = process.env.APP_DB_SSL === 'true'
      ? { rejectUnauthorized: false }
      : undefined;

    pool = new Pool({
      host:     process.env.APP_DB_HOST     || 'localhost',
      port:     parseInt(process.env.APP_DB_PORT || '5432', 10),
      database: process.env.APP_DB_NAME     || 'dataguard',
      user:     process.env.APP_DB_USER     || 'dataguard',
      password: process.env.APP_DB_PASSWORD,
      ssl,
      max:      10,
      idleTimeoutMillis:    30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
      logger.error('Unexpected app-DB pool error', { message: err.message });
    });
  }
  return pool;
}

/**
 * Run a parameterised query against the app database.
 */
async function query(sql, params = []) {
  const client = await getPool().connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/**
 * Run multiple statements in a single transaction.
 * @param {(client: import('pg').PoolClient) => Promise<void>} fn
 */
async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function testConnection() {
  const res = await query('SELECT NOW() AS now');
  return res.rows[0].now;
}

module.exports = { query, transaction, testConnection, getPool };
