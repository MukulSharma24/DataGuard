'use strict';

const express = require('express');
const Joi     = require('joi');
const { query } = require('../config/database');
const { encrypt, decrypt, maskConnectionConfig } = require('../utils/crypto');
const pgConnector    = require('../connectors/postgresConnector');
const mongoConnector = require('../connectors/mongodbConnector');
const { cacheGet, cacheSet, cacheDel } = require('../utils/cache');

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const pgConfigSchema = Joi.object({
  host:             Joi.string().required(),
  port:             Joi.number().integer().min(1).max(65535).default(5432),
  database:         Joi.string().required(),
  user:             Joi.string().required(),
  password:         Joi.string().allow('').optional(),
  ssl:              Joi.boolean().default(false),
  connectionString: Joi.string().optional(),
});

const mongoConfigSchema = Joi.object({
  host:             Joi.string().allow('').optional(),
  port:             Joi.number().integer().optional(),
  database:         Joi.string().allow('').optional(),
  user:             Joi.string().allow('').optional(),
  password:         Joi.string().allow('').optional(),
  connectionString: Joi.string().optional(),
}).or('connectionString', 'host');

const createSourceSchema = Joi.object({
  name:   Joi.string().min(1).max(255).required(),
  type:   Joi.string().valid('postgresql', 'mongodb').required(),
  config: Joi.object().required(),
});

// ---------------------------------------------------------------------------
// GET /api/sources
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const cached = await cacheGet('sources:list');
  if (cached) return res.json({ sources: cached });

  // CTE pre-aggregates pii counts once across all sources — avoids N correlated subqueries
  const { rows } = await query(
    `WITH pii_counts AS (
       SELECT sr.source_id,
              COUNT(DISTINCT f.schema_name || '.' || f.table_name || '.' || f.field_path) AS cnt
       FROM scan_runs sr
       JOIN findings f ON f.scan_run_id = sr.id
       WHERE sr.status IN ('completed', 'partial')
       GROUP BY sr.source_id
     )
     SELECT ds.id, ds.name, ds.type, ds.status, ds.last_scanned, ds.created_at, ds.updated_at,
            COALESCE(pii.cnt, 0)::int AS pii_fields_found
     FROM data_sources ds
     LEFT JOIN pii_counts pii ON pii.source_id = ds.id
     ORDER BY ds.created_at DESC`
  );
  await cacheSet('sources:list', rows, 15); // 15s TTL — invalidated on scan completion
  res.json({ sources: rows });
});

// ---------------------------------------------------------------------------
// POST /api/sources
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { error, value } = createSourceSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { name, type, config } = value;

  // Validate the connector config shape
  const configSchema = type === 'postgresql' ? pgConfigSchema : mongoConfigSchema;
  const { error: cfgErr, value: cleanConfig } = configSchema.validate(config);
  if (cfgErr) return res.status(400).json({ error: `Connection config: ${cfgErr.details[0].message}` });

  const encryptedConfig = encrypt(JSON.stringify(cleanConfig));

  const { rows } = await query(
    `INSERT INTO data_sources (name, type, connection_config)
     VALUES ($1, $2, $3)
     RETURNING id, name, type, status, last_scanned, created_at`,
    [name, type, encryptedConfig]
  );

  res.status(201).json({ source: rows[0] });
});

// ---------------------------------------------------------------------------
// GET /api/sources/:id  — returns masked config for edit form
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, type, status, last_scanned, created_at, updated_at, connection_config
     FROM data_sources WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Source not found' });

  const { connection_config, ...src } = rows[0];
  let maskedConfig = null;
  try {
    maskedConfig = maskConnectionConfig(JSON.parse(decrypt(connection_config)));
  } catch {}

  res.json({ source: { ...src, maskedConfig } });
});

// ---------------------------------------------------------------------------
// PATCH /api/sources/:id  — partial update (PUT also accepted for compatibility)
// ---------------------------------------------------------------------------
router.patch('/:id', handleSourceUpdate);
router.put('/:id',   handleSourceUpdate);

async function handleSourceUpdate(req, res) {
  const allowed = Joi.object({
    name:   Joi.string().min(1).max(255),
    status: Joi.string().valid('active', 'inactive'),
    config: Joi.object().optional(), // re-encrypt if provided
  });

  const { error, value } = allowed.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  // Fetch current row to ensure it exists (also need connection_config to merge passwords)
  const { rows: existing } = await query(
    `SELECT id, type, connection_config FROM data_sources WHERE id = $1`,
    [req.params.id]
  );
  if (!existing.length) return res.status(404).json({ error: 'Source not found' });

  const updates = [];
  const params  = [];
  let idx = 1;

  if (value.name)   { updates.push(`name = $${idx++}`);   params.push(value.name); }
  if (value.status) { updates.push(`status = $${idx++}`); params.push(value.status); }

  if (value.config) {
    // Merge with existing config — keep the stored password if the update leaves it blank
    let existingConfig = {};
    try { existingConfig = JSON.parse(decrypt(existing[0].connection_config)); } catch {}
    const merged = { ...existingConfig, ...value.config };

    // Keep existing password field if blank
    if (!value.config.password) merged.password = existingConfig.password;

    // Keep existing connectionString if the user submitted the masked placeholder (***).
    // The edit form pre-fills with a masked URI — if the user didn't type a real new one,
    // we must restore the stored URI so *** is never saved as the actual password.
    if (merged.connectionString && merged.connectionString.includes(':***@')) {
      merged.connectionString = existingConfig.connectionString;
    }

    const encryptedConfig = encrypt(JSON.stringify(merged));
    updates.push(`connection_config = $${idx++}`);
    params.push(encryptedConfig);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No updatable fields provided' });

  params.push(req.params.id);
  await query(
    `UPDATE data_sources SET ${updates.join(', ')} WHERE id = $${idx}`,
    params
  );

  const { rows } = await query(
    `SELECT id, name, type, status, last_scanned, created_at, updated_at
     FROM data_sources WHERE id = $1`,
    [req.params.id]
  );
  res.json({ source: rows[0] });
}

// ---------------------------------------------------------------------------
// DELETE /api/sources/:id  — 204 No Content on success
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const { rowCount } = await query(`DELETE FROM data_sources WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Source not found' });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /api/sources/:id/test  — test connectivity
// ---------------------------------------------------------------------------
router.post('/:id/test', async (req, res) => {
  const { rows } = await query(
    `SELECT id, type, connection_config FROM data_sources WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Source not found' });

  const { type, connection_config } = rows[0];

  let connConfig;
  try {
    connConfig = JSON.parse(decrypt(connection_config));
  } catch {
    return res.status(500).json({ error: 'Failed to decrypt connection config' });
  }

  let result;
  if (type === 'postgresql') {
    result = await pgConnector.testConnection(connConfig);
  } else {
    result = await mongoConnector.testConnection(connConfig);
  }

  // Update status based on test result
  const newStatus = result.success ? 'active' : 'error';
  await query(`UPDATE data_sources SET status = $1 WHERE id = $2`, [newStatus, req.params.id]);

  res.json({
    success:   result.success,
    latencyMs: result.latencyMs,
    error:     result.error ?? null,
  });
});

module.exports = router;
