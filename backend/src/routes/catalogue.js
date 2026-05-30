'use strict';

const express = require('express');
const { query, transaction } = require('../config/database');
const { cacheGet, cacheSet } = require('../utils/cache');

const router = express.Router();
const MAX_LIMIT = 500;

// POST /api/catalogue/publish/:scanId
// Moves all confirmed findings from a scan run into the catalogue.
router.post('/publish/:scanId', async (req, res) => {
  const { scanId } = req.params;

  // Verify scan exists and is completed
  const { rows: scans } = await query(
    `SELECT r.id, r.status, s.name as source_name, s.type as source_type
     FROM scan_runs r
     JOIN data_sources s ON s.id = r.source_id
     WHERE r.id = $1`,
    [scanId]
  );
  if (!scans.length) return res.status(404).json({ error: 'Scan not found' });

  const scan = scans[0];
  if (!['completed', 'partial'].includes(scan.status)) {
    return res.status(400).json({ error: 'Can only publish from completed or partial scans' });
  }

  // Batch INSERT + batch UPDATE — 2 queries instead of 2×N
  const { rows: inserted } = await transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO catalogue_entries
         (finding_id, scan_run_id, source_id, source_name, source_type,
          schema_name, table_name, field_path, pii_category, confidence_level,
          scan_run_id_ref)
       SELECT f.id, f.scan_run_id, f.source_id, $2, $3,
              f.schema_name, f.table_name, f.field_path, f.pii_category, f.confidence_level, f.scan_run_id
       FROM findings f
       WHERE f.scan_run_id = $1
         AND f.review_status = 'confirmed'
         AND f.published = FALSE
       ON CONFLICT (finding_id) DO NOTHING
       RETURNING id`,
      [scanId, scan.source_name, scan.source_type]
    );

    await client.query(
      `UPDATE findings SET published = TRUE
       WHERE scan_run_id = $1
         AND review_status = 'confirmed'
         AND published = FALSE`,
      [scanId]
    );

    return rows;
  });

  const publishedCount = inserted.length;
  if (!publishedCount) {
    return res.json({ message: 'No confirmed unpublished findings', published: 0 });
  }

  res.json({ message: `Published ${publishedCount} finding(s)`, published: publishedCount });
});

// GET /api/catalogue
// view=published (default) — catalogue_entries (confirmed + published)
// view=pending             — unreviewed findings from completed scans
router.get('/', async (req, res) => {
  const { source_id, category, view = 'published', limit = 100, offset = 0 } = req.query;
  const params  = [];
  const filters = [];
  let idx = 1;

  if (view === 'pending') {
    if (source_id) { filters.push(`sr.source_id = $${idx++}`);  params.push(source_id); }
    if (category)  { filters.push(`f.pii_category = $${idx++}`); params.push(category); }
    const where = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT DISTINCT ON (f.source_id, f.schema_name, f.table_name, f.field_path)
         f.id, f.scan_run_id, sr.source_id, ds.name AS source_name, ds.type AS source_type,
         f.schema_name, f.table_name, f.field_path, f.pii_category,
         f.confidence_level, f.confidence_score, f.detection_reason,
         f.review_status, f.created_at AS confirmed_at
       FROM findings f
       JOIN scan_runs sr ON sr.id = f.scan_run_id
       JOIN data_sources ds ON ds.id = sr.source_id
       WHERE sr.status IN ('completed','partial')
         AND f.review_status = 'unreviewed'
         ${where}
       ORDER BY f.source_id, f.schema_name, f.table_name, f.field_path, f.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, Math.min(parseInt(limit, 10) || 100, MAX_LIMIT), parseInt(offset, 10) || 0]
    );
    return res.json({ entries: rows });
  }

  // Default: published catalogue entries
  if (source_id) { filters.push(`source_id = $${idx++}`);    params.push(source_id); }
  if (category)  { filters.push(`pii_category = $${idx++}`); params.push(category); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const { rows } = await query(
    `SELECT * FROM catalogue_entries
     ${where}
     ORDER BY confirmed_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, Math.min(parseInt(limit, 10) || 100, MAX_LIMIT), parseInt(offset, 10) || 0]
  );
  res.json({ entries: rows });
});

// GET /api/catalogue/by-source
router.get('/by-source', async (req, res) => {
  const { rows } = await query(`
    SELECT
      source_id,
      source_name,
      source_type,
      COUNT(*)                                        AS total_fields,
      COUNT(DISTINCT pii_category)                    AS categories_found,
      MAX(confirmed_at)                               AS last_published,
      json_agg(DISTINCT pii_category)                 AS categories
    FROM catalogue_entries
    GROUP BY source_id, source_name, source_type
    ORDER BY source_name
  `);
  res.json({ bySource: rows });
});

// GET /api/catalogue/by-category
router.get('/by-category', async (req, res) => {
  const { rows } = await query(`
    SELECT
      pii_category,
      COUNT(*)                          AS total_fields,
      COUNT(DISTINCT source_id)         AS sources_affected,
      json_agg(DISTINCT source_name)    AS sources
    FROM catalogue_entries
    GROUP BY pii_category
    ORDER BY total_fields DESC
  `);
  res.json({ byCategory: rows });
});

// GET /api/catalogue/stats  — summary stats for the overview page
router.get('/stats', async (req, res) => {
  const cached = await cacheGet('catalogue:stats');
  if (cached) return res.json({ stats: cached });

  const { rows: [stats] } = await query(`
    WITH done AS (
      SELECT f.schema_name, f.table_name, f.field_path, f.review_status
      FROM findings f
      JOIN scan_runs sr ON sr.id = f.scan_run_id
      WHERE sr.status IN ('completed', 'partial')
    )
    SELECT
      (SELECT COUNT(*) FROM data_sources)                                        AS total_sources,
      (SELECT COUNT(*) FROM scan_runs WHERE status NOT IN ('running','pending')) AS total_scans,
      (SELECT COUNT(DISTINCT schema_name || '.' || table_name || '.' || field_path) FROM done)                             AS total_findings,
      (SELECT COUNT(DISTINCT schema_name || '.' || table_name || '.' || field_path) FROM done WHERE review_status = 'confirmed')  AS confirmed_findings,
      (SELECT COUNT(DISTINCT schema_name || '.' || table_name || '.' || field_path) FROM done WHERE review_status = 'unreviewed') AS unreviewed_findings,
      (SELECT COUNT(*) FROM catalogue_entries)                                   AS catalogue_entries
  `);
  await cacheSet('catalogue:stats', stats, 30); // 30s TTL
  res.json({ stats });
});

module.exports = router;
