-- Migration 003: Fix cancelled status, add missing indexes, catalogue composite indexes
-- Run with: npm run migrate

-- ─────────────────────────────────────────────
-- FIX: Add 'cancelled' to scan_runs status enum
-- The inline CHECK constraint auto-name is scan_runs_status_check.
-- We drop and recreate to add the new value.
-- ─────────────────────────────────────────────
ALTER TABLE scan_runs DROP CONSTRAINT IF EXISTS scan_runs_status_check;
ALTER TABLE scan_runs
  ADD CONSTRAINT scan_runs_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'failed', 'partial', 'cancelled'));

-- ─────────────────────────────────────────────
-- SORT ORDER INDEXES
-- ORDER BY created_at DESC is the default sort on every list endpoint
-- but neither table had an index on that column.
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_scan_runs_created_at
  ON scan_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_sources_created_at
  ON data_sources(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scan_profiles_created_at
  ON scan_profiles(created_at DESC);

-- ─────────────────────────────────────────────
-- COMPOSITE INDEX: scan_runs(source_id, status)
-- Covers the pii_fields_found CTE JOIN and the scans-by-source filter
-- simultaneously — both columns needed in one lookup.
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_scan_runs_source_status
  ON scan_runs(source_id, status);

-- ─────────────────────────────────────────────
-- PARTIAL INDEX: unreviewed findings
-- The catalogue "pending" view and the sources pii_fields_found count
-- both filter on specific review statuses. A partial index is far smaller
-- than a full index and only covers the rows that matter for these queries.
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_findings_unreviewed
  ON findings(source_id, schema_name, table_name, field_path, created_at DESC)
  WHERE review_status = 'unreviewed';

CREATE INDEX IF NOT EXISTS idx_findings_confirmed
  ON findings(scan_run_id, published)
  WHERE review_status = 'confirmed';

-- ─────────────────────────────────────────────
-- COMPOSITE INDEX: catalogue_entries(source_id, pii_category)
-- Covers the filtered catalogue list query when both filters are applied.
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_catalogue_source_category
  ON catalogue_entries(source_id, pii_category);

-- ─────────────────────────────────────────────
-- COMPOSITE INDEX: catalogue_entries(pii_category, confirmed_at)
-- Covers the by-category aggregation and the default ORDER BY.
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_catalogue_category_confirmed
  ON catalogue_entries(pii_category, confirmed_at DESC);
