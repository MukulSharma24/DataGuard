'use strict';

const express = require('express');
const Joi     = require('joi');
const { query } = require('../config/database');

const router = express.Router();

const PII_CATEGORIES = [
  'NAME','EMAIL','PHONE','ADDRESS','DOB','GENDER',
  'AADHAAR','PAN','BANK_ACCOUNT','USER_ID','CREDENTIAL',
];

// PATCH /api/findings/:id — confirm, reject, or reclassify
router.patch('/:id', async (req, res) => {
  const schema = Joi.object({
    review_status: Joi.string().valid('confirmed', 'rejected', 'reclassified').required(),
    review_note:   Joi.string().max(2000).optional().allow('', null),
    pii_category:  Joi.string().valid(...PII_CATEGORIES).when('review_status', {
      is: 'reclassified', then: Joi.required(),
    }),
    reviewed_by:   Joi.string().max(255).optional().allow('', null),
  });

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { rows: existing } = await query(`SELECT id FROM findings WHERE id = $1`, [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: 'Finding not found' });

  const updates = [
    `review_status = $1`,
    `reviewed_at   = NOW()`,
  ];
  const params = [value.review_status];
  let idx = 2;

  if (value.review_note !== undefined)  { updates.push(`review_note = $${idx++}`);  params.push(value.review_note); }
  if (value.pii_category !== undefined) { updates.push(`pii_category = $${idx++}`); params.push(value.pii_category); }
  if (value.reviewed_by !== undefined)  { updates.push(`reviewed_by = $${idx++}`);  params.push(value.reviewed_by); }

  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE findings SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  res.json({ finding: rows[0] });
});

// GET /api/findings/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query(`SELECT * FROM findings WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Finding not found' });
  res.json({ finding: rows[0] });
});

module.exports = router;
