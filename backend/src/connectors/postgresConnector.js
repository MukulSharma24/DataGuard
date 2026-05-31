'use strict';

const { Client, Pool } = require('pg');
const logger = require('../utils/logger');

const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS   = 30_000;
const SAMPLE_LIMIT       = 100;
const POOL_MAX           = 5;

/** Build a pg.Pool from a plain config object. Credentials are NEVER logged. */
function createPool(config) {
  return new Pool({
    host:             config.host     || 'localhost',
    port:             parseInt(config.port || '5432', 10),
    database:         config.database,
    user:             config.user,
    password:         config.password || undefined,
    connectionString: config.connectionString || undefined,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout:           QUERY_TIMEOUT_MS,
    ssl:              config.ssl ? { rejectUnauthorized: false } : false,
    max:              POOL_MAX,
    idleTimeoutMillis: 30_000,
  });
}

/** Test a connection and return { success, latencyMs, error }. */
async function testConnection(config) {
  const client = new Client({
    host:     config.host     || 'localhost',
    port:     parseInt(config.port || '5432', 10),
    database: config.database,
    user:     config.user,
    password: config.password || undefined,
    connectionString: config.connectionString || undefined,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ssl:      config.ssl ? { rejectUnauthorized: false } : false,
  });
  const start = Date.now();
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { success: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Discover all schemas (excluding system schemas) and their tables + columns.
 * Accepts a pg.Pool — caller is responsible for pool lifecycle.
 */
async function discoverSchema(pool) {
  logger.info('PostgreSQL — discovering schema');

  const schemasRes = await pool.query(`
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1')
      AND schema_name NOT LIKE 'pg_%'
    ORDER BY schema_name
  `);

  const schemas = [];

  for (const { schema_name: schema } of schemasRes.rows) {
    const tablesRes = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `, [schema]);

    const tables = [];

    for (const { table_name: tableName } of tablesRes.rows) {
      const colsRes = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `, [schema, tableName]);

      tables.push({
        name:    tableName,
        columns: colsRes.rows.map(r => ({
          name:       r.column_name,
          dataType:   r.data_type,
          isNullable: r.is_nullable === 'YES',
        })),
      });
    }

    schemas.push({ schema, tables });
  }

  return schemas;
}

/**
 * Returns a Set of table names that have not been modified since sinceTimestamp.
 *
 * Uses pg_stat_user_tables: n_mod_since_analyze = 0 means no rows changed since
 * the last ANALYZE, and we verify the ANALYZE itself happened after our last scan —
 * so the "clean" state definitely post-dates the previous scan run.
 */
async function getUnchangedTables(pool, schema, tableNames, sinceTimestamp) {
  if (!sinceTimestamp || tableNames.length === 0) return new Set();
  try {
    const res = await pool.query(`
      SELECT relname
      FROM pg_stat_user_tables
      WHERE schemaname = $1
        AND relname     = ANY($2)
        AND n_mod_since_analyze = 0
        AND GREATEST(
          COALESCE(last_autoanalyze, '1970-01-01'::timestamptz),
          COALESCE(last_autovacuum,  '1970-01-01'::timestamptz)
        ) > $3::timestamptz
    `, [schema, tableNames, sinceTimestamp]);
    return new Set(res.rows.map(r => r.relname));
  } catch {
    return new Set(); // pg_stat_user_tables may be restricted in some configs
  }
}

/**
 * Sample non-null values for a specific column using distributed sampling.
 *
 * Strategy:
 *  - Small tables  (total non-null <= limit*2): return all non-null rows up to limit
 *  - Large tables  (total non-null >  limit*2): split limit into 3 equal slices —
 *      beginning (rows 0..slice), middle (rows ~total/2), end (rows ~total-slice)
 */
async function sampleColumn(client, schema, table, column, limit = SAMPLE_LIMIT) {
  const safeSchema = sanitiseIdentifier(schema);
  const safeTable  = sanitiseIdentifier(table);
  const safeColumn = sanitiseIdentifier(column);
  const base       = `${safeSchema}.${safeTable} WHERE ${safeColumn} IS NOT NULL`;

  const { rows: [{ cnt }] } = await client.query(
    `SELECT COUNT(*) AS cnt FROM ${safeSchema}.${safeTable} WHERE ${safeColumn} IS NOT NULL`
  );
  const total = parseInt(cnt, 10);

  if (total <= limit * 2) {
    const res = await client.query(
      `SELECT ${safeColumn} AS val FROM ${base} ORDER BY ctid LIMIT $1`, [limit]
    );
    return res.rows.map(r => r.val);
  }

  const slice     = Math.ceil(limit / 3);
  const midOffset = Math.max(0, Math.floor(total / 2) - Math.floor(slice / 2));
  const endOffset = Math.max(midOffset + slice, total - slice);

  // ORDER BY ctid ensures the same physical rows are selected on every run for
  // unchanged data — without it, PostgreSQL heap order shifts on autovacuum/VACUUM
  // causing different samples and non-deterministic finding counts.
  const res = await client.query(
    `(SELECT ${safeColumn} AS val FROM ${base} ORDER BY ctid LIMIT $1)
     UNION ALL
     (SELECT ${safeColumn} AS val FROM ${base} ORDER BY ctid OFFSET $2 LIMIT $3)
     UNION ALL
     (SELECT ${safeColumn} AS val FROM ${base} ORDER BY ctid OFFSET $4 LIMIT $5)`,
    [slice, midOffset, slice, endOffset, slice]
  );
  return res.rows.map(r => r.val);
}

/**
 * For a given table, sample up to sampleSize values per column.
 * Accepts a pg.Pool — acquires one connection for the duration of all column batches,
 * then releases it back to the pool.
 */
async function sampleTable(pool, schema, tableName, columns, batchSize = 20, sampleSize = SAMPLE_LIMIT) {
  const client = await pool.connect();
  try {
    // REPEATABLE READ ensures COUNT(*) and the subsequent SELECT see the exact same
    // heap snapshot. Without this, autovacuum can move rows between the two queries,
    // making OFFSET-based sampling non-deterministic across scan runs.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const results = [];

    for (let i = 0; i < columns.length; i += batchSize) {
      const batch = columns.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async col => {
          try {
            const samples = await sampleColumn(client, schema, tableName, col.name, sampleSize);
            return { name: col.name, samples };
          } catch (err) {
            logger.warn(`Failed to sample column ${schema}.${tableName}.${col.name}`, { message: err.message });
            return { name: col.name, samples: [] };
          }
        })
      );
      results.push(...batchResults);
    }

    await client.query('COMMIT');
    return results;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Prevent SQL injection in identifier positions (table/column names)
function sanitiseIdentifier(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(name)) {
    return `"${name.replace(/"/g, '""')}"`;
  }
  return `"${name}"`;
}

module.exports = { testConnection, createPool, discoverSchema, sampleTable, getUnchangedTables };
