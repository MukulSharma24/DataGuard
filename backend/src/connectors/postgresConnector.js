'use strict';

const { Client, Pool } = require('pg');
const logger = require('../utils/logger');

const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS   = 30_000;
const SAMPLE_LIMIT       = 500;
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
 * Single JOIN query replaces the old N+1 loop (1 per schema + 1 per table).
 * Accepts a pg.Pool — caller is responsible for pool lifecycle.
 */
async function discoverSchema(pool) {
  logger.info('PostgreSQL — discovering schema');

  const { rows } = await pool.query(`
    SELECT
      t.table_schema  AS schema_name,
      t.table_name,
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.ordinal_position
    FROM information_schema.tables  t
    JOIN information_schema.columns c
      ON  c.table_schema = t.table_schema
      AND c.table_name   = t.table_name
    WHERE t.table_schema NOT IN ('pg_catalog','information_schema','pg_toast','pg_temp_1','pg_toast_temp_1')
      AND t.table_schema NOT LIKE 'pg_%'
      AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_schema, t.table_name, c.ordinal_position
  `);

  // Group flat rows into nested schemas → tables → columns
  const schemaMap = new Map();
  for (const row of rows) {
    if (!schemaMap.has(row.schema_name)) schemaMap.set(row.schema_name, new Map());
    const tableMap = schemaMap.get(row.schema_name);
    if (!tableMap.has(row.table_name)) tableMap.set(row.table_name, []);
    tableMap.get(row.table_name).push({
      name:       row.column_name,
      dataType:   row.data_type,
      isNullable: row.is_nullable === 'YES',
    });
  }

  const schemas = [];
  for (const [schema, tableMap] of schemaMap) {
    const tables = [];
    for (const [tableName, columns] of tableMap) {
      tables.push({ name: tableName, columns });
    }
    schemas.push({ schema, tables });
  }
  return schemas;
}

/**
 * Discover all declared foreign-key relationships in the database.
 * Returns [{ schema, table, column, refSchema, refTable, refColumn }].
 *
 * This is what powers cross-table awareness: a column that points at a table
 * holding PII is an indirect identifier even if its own values look harmless.
 */
async function discoverForeignKeys(pool) {
  const { rows } = await pool.query(`
    SELECT
      tc.table_schema  AS schema_name,
      tc.table_name    AS table_name,
      kcu.column_name  AS column_name,
      ccu.table_schema AS ref_schema,
      ccu.table_name   AS ref_table,
      ccu.column_name  AS ref_column
    FROM information_schema.table_constraints       tc
    JOIN information_schema.key_column_usage        kcu
      ON  kcu.constraint_name   = tc.constraint_name
      AND kcu.constraint_schema = tc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON  ccu.constraint_name   = tc.constraint_name
      AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema NOT IN ('pg_catalog','information_schema')
  `);
  return rows.map(r => ({
    schema:    r.schema_name,
    table:     r.table_name,
    column:    r.column_name,
    refSchema: r.ref_schema,
    refTable:  r.ref_table,
    refColumn: r.ref_column,
  }));
}

// Column types that can carry a meaningful record timestamp
const DATE_TYPES = new Set([
  'timestamp with time zone', 'timestamp without time zone',
  'timestamptz', 'timestamp', 'date',
]);
// Preferred timestamp column names, in priority order (underscores ignored)
const DATE_COL_PREFERENCE = [
  'createdat', 'inserted', 'insertedat', 'created', 'registeredat',
  'signupdate', 'datecreated', 'timestamp', 'updatedat', 'modifiedat', 'date',
];

/**
 * Find the data's date range for a table — how old the records actually are.
 * Picks the most likely "record created" timestamp column (by name, else any
 * date-typed column) and returns its MIN/MAX. Returns null if the table has no
 * usable date column or is empty.
 */
async function getTableDateRange(pool, schema, table, columns) {
  const dateCols = columns.filter(c => DATE_TYPES.has((c.dataType || '').toLowerCase()));
  if (dateCols.length === 0) return null;

  let chosen = null;
  for (const pref of DATE_COL_PREFERENCE) {
    chosen = dateCols.find(c => c.name.toLowerCase().replace(/_/g, '') === pref);
    if (chosen) break;
  }
  if (!chosen) chosen = dateCols[0];

  const safeSchema = sanitiseIdentifier(schema);
  const safeTable  = sanitiseIdentifier(table);
  const safeCol    = sanitiseIdentifier(chosen.name);

  try {
    const { rows: [r] } = await pool.query(
      `SELECT MIN(${safeCol}) AS oldest, MAX(${safeCol}) AS newest FROM ${safeSchema}.${safeTable}`
    );
    if (!r || !r.oldest) return null;
    return { oldest: r.oldest, newest: r.newest, column: chosen.name };
  } catch {
    return null; // permission denied, weird type, etc. — fail soft
  }
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

module.exports = {
  testConnection, createPool, discoverSchema, sampleTable,
  getUnchangedTables, discoverForeignKeys, getTableDateRange,
};
