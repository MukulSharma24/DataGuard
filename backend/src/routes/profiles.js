'use strict';

const express = require('express');
const Joi     = require('joi');
const { query } = require('../config/database');

const router = express.Router();

const profileSchema = Joi.object({
  source_id:   Joi.string().uuid().required(),
  name:        Joi.string().min(1).max(255).required(),
  description: Joi.string().max(1000).optional().allow(''),
  config: Joi.object({
    includeSchemas:      Joi.array().items(Joi.string()).default([]),
    excludeSchemas:      Joi.array().items(Joi.string()).default([]),
    includeCollections:  Joi.array().items(Joi.string()).default([]),
    excludeCollections:  Joi.array().items(Joi.string()).default([]),
    sampleSize:          Joi.number().integer().min(1).max(1000).default(100),
    batchSize:           Joi.number().integer().min(1).max(100).default(20),
  }).default({}),
});

// GET /api/profiles
router.get('/', async (req, res) => {
  const { source_id } = req.query;
  let sql    = `SELECT p.*, s.name as source_name, s.type as source_type
                FROM scan_profiles p
                JOIN data_sources s ON s.id = p.source_id`;
  const params = [];

  if (source_id) {
    sql += ` WHERE p.source_id = $1`;
    params.push(source_id);
  }
  sql += ` ORDER BY p.created_at DESC`;

  const { rows } = await query(sql, params);
  res.json({ profiles: rows });
});

// GET /api/profiles/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, s.name as source_name, s.type as source_type
     FROM scan_profiles p
     JOIN data_sources s ON s.id = p.source_id
     WHERE p.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Profile not found' });
  res.json({ profile: rows[0] });
});

// POST /api/profiles
router.post('/', async (req, res) => {
  const { error, value } = profileSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { source_id, name, description, config } = value;

  // Verify source exists
  const { rows: src } = await query(`SELECT id FROM data_sources WHERE id = $1`, [source_id]);
  if (!src.length) return res.status(404).json({ error: 'Data source not found' });

  const { rows } = await query(
    `INSERT INTO scan_profiles (source_id, name, description, config)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [source_id, name, description || null, JSON.stringify(config)]
  );
  res.status(201).json({ profile: rows[0] });
});

const profileConfigSchema = Joi.object({
  includeSchemas:      Joi.array().items(Joi.string()).default([]),
  excludeSchemas:      Joi.array().items(Joi.string()).default([]),
  includeCollections:  Joi.array().items(Joi.string()).default([]),
  excludeCollections:  Joi.array().items(Joi.string()).default([]),
  sampleSize:          Joi.number().integer().min(1).max(1000).default(100),
  batchSize:           Joi.number().integer().min(1).max(100).default(20),
});

// PATCH /api/profiles/:id  — partial update (PUT also accepted for compatibility)
router.patch('/:id', handleProfileUpdate);
router.put('/:id',   handleProfileUpdate);

async function handleProfileUpdate(req, res) {
  const allowed = Joi.object({
    name:        Joi.string().min(1).max(255),
    description: Joi.string().max(1000).allow(''),
    config:      profileConfigSchema,
  });
  const { error, value } = allowed.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { rows: existing } = await query(`SELECT id FROM scan_profiles WHERE id = $1`, [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: 'Profile not found' });

  const updates = [];
  const params  = [];
  let idx = 1;

  if (value.name !== undefined)        { updates.push(`name = $${idx++}`);        params.push(value.name); }
  if (value.description !== undefined) { updates.push(`description = $${idx++}`); params.push(value.description); }
  if (value.config !== undefined)      { updates.push(`config = $${idx++}`);      params.push(JSON.stringify(value.config)); }

  if (!updates.length) return res.status(400).json({ error: 'No updatable fields' });

  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE scan_profiles SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  res.json({ profile: rows[0] });
}

// DELETE /api/profiles/:id  — 204 No Content on success
router.delete('/:id', async (req, res) => {
  const { rowCount } = await query(`DELETE FROM scan_profiles WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Profile not found' });
  res.status(204).end();
});

module.exports = router;
