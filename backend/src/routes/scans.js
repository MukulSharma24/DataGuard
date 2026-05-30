'use strict';

const express = require('express');
const Joi     = require('joi');
const { query } = require('../config/database');
const { decrypt } = require('../utils/crypto');
const { triggerScan, cancelScan } = require('../scanner/scanEngine');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUUID(req, res, next) {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  next();
}

const MAX_LIMIT = 500;

// GET /api/scans
router.get('/', async (req, res) => {
  const { source_id, status, limit = 50, offset = 0 } = req.query;
  const params  = [];
  const filters = [];
  let idx = 1;

  if (source_id) { filters.push(`r.source_id = $${idx++}`); params.push(source_id); }
  if (status)    { filters.push(`r.status = $${idx++}`);    params.push(status); }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT r.id, r.status, r.started_at, r.completed_at,
            r.tables_scanned, r.findings_count, r.error_message,
            r.created_at,
            p.name as profile_name,
            s.name as source_name, s.type as source_type
     FROM scan_runs r
     JOIN scan_profiles p ON p.id = r.profile_id
     JOIN data_sources  s ON s.id = r.source_id
     ${where}
     ORDER BY r.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, Math.min(parseInt(limit, 10) || 50, MAX_LIMIT), parseInt(offset, 10) || 0]
  );
  res.json({ scans: rows });
});

// GET /api/scans/:id
router.get('/:id', requireUUID, async (req, res) => {
  const { rows } = await query(
    `SELECT r.*,
            p.name as profile_name, p.config as profile_config,
            s.name as source_name, s.type as source_type,
            CASE WHEN r.scan_duration_ms > 0 AND r.rows_sampled > 0
                 THEN ROUND((r.rows_sampled::numeric / r.scan_duration_ms) * 1000)
                 ELSE 0
            END AS rows_per_second
     FROM scan_runs r
     JOIN scan_profiles p ON p.id = r.profile_id
     JOIN data_sources  s ON s.id = r.source_id
     WHERE r.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Scan not found' });
  res.json({ scan: rows[0] });
});

// GET /api/scans/:id/findings
router.get('/:id/findings', requireUUID, async (req, res) => {
  const { category, confidence_level, review_status } = req.query;
  const params  = [req.params.id];
  const filters = [`f.scan_run_id = $1`];
  let idx = 2;

  if (category)         { filters.push(`f.pii_category = $${idx++}`);      params.push(category); }
  if (confidence_level) { filters.push(`f.confidence_level = $${idx++}`);   params.push(confidence_level); }
  if (review_status)    { filters.push(`f.review_status = $${idx++}`);       params.push(review_status); }

  const { rows } = await query(
    `SELECT f.*
     FROM findings f
     WHERE ${filters.join(' AND ')}
     ORDER BY f.confidence_score DESC, f.table_name, f.field_path`,
    params
  );
  res.json({ findings: rows });
});

// POST /api/scans  — trigger a new scan
router.post('/', async (req, res) => {
  const schema = Joi.object({ profile_id: Joi.string().uuid().required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { profile_id } = value;

  // Load profile + source
  const { rows: profiles } = await query(
    `SELECT p.*, s.type as source_type, s.connection_config, s.status as source_status
     FROM scan_profiles p
     JOIN data_sources s ON s.id = p.source_id
     WHERE p.id = $1`,
    [profile_id]
  );
  if (!profiles.length) return res.status(404).json({ error: 'Profile not found' });

  const profile = profiles[0];
  if (profile.source_status === 'inactive') {
    return res.status(400).json({ error: 'Data source is inactive' });
  }

  let connConfig;
  try {
    connConfig = JSON.parse(decrypt(profile.connection_config));
  } catch {
    return res.status(500).json({ error: 'Failed to decrypt connection config' });
  }

  const scanRunId = await triggerScan(
    profile_id,
    profile.source_id,
    connConfig,
    profile.source_type,
    profile.config
  );

  res.status(202).json({ scan_run_id: scanRunId, status: 'running' });
});

// DELETE /api/scans/:id  — cancel a running scan
router.delete('/:id', requireUUID, async (req, res) => {
  const { rows } = await query(
    `SELECT id, status FROM scan_runs WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Scan not found' });
  if (rows[0].status !== 'running') {
    return res.status(400).json({ error: `Scan is already ${rows[0].status} — cannot cancel` });
  }

  cancelScan(req.params.id);
  res.json({ message: 'Cancellation requested — scan will stop after the current table completes' });
});

module.exports = router;
