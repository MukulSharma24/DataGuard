-- Migration 002: Add missing indexes, unique constraints, and FK indexes
-- Every FK column should have an index (PostgreSQL does NOT auto-create them).
-- Unique constraints enforce data integrity at the DB level, not just in application code.

-- ─────────────────────────────────────────────
-- UNIQUE CONSTRAINTS (idempotent via DO blocks)
-- ─────────────────────────────────────────────

-- A scan profile name must be unique per source.
DO $$ BEGIN
  ALTER TABLE scan_profiles
    ADD CONSTRAINT uq_scan_profiles_source_name UNIQUE (source_id, name);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- A field path can only appear once per (scan_run, schema, table).
-- field_path alone is not unique across a scan — two tables can both have an 'email' column.
DO $$ BEGIN
  ALTER TABLE findings
    ADD CONSTRAINT uq_findings_scan_field UNIQUE (scan_run_id, schema_name, table_name, field_path);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- A finding can only be published once.
-- Replaces the application-level ON CONFLICT DO NOTHING with a real DB guarantee.
DO $$ BEGIN
  ALTER TABLE catalogue_entries
    ADD CONSTRAINT uq_catalogue_finding UNIQUE (finding_id);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- ─────────────────────────────────────────────
-- FK INDEXES
-- PostgreSQL auto-creates indexes on PK columns but NOT on FK columns.
-- Missing FK indexes cause slow ON DELETE CASCADE and slow JOIN queries.
-- ─────────────────────────────────────────────

-- scan_profiles.source_id — JOIN and WHERE source_id = ?
CREATE INDEX IF NOT EXISTS idx_scan_profiles_source
  ON scan_profiles(source_id);

-- scan_runs.profile_id — JOIN to get profile name
CREATE INDEX IF NOT EXISTS idx_scan_runs_profile
  ON scan_runs(profile_id);

-- scan_runs.source_id — WHERE source_id = ? filter
CREATE INDEX IF NOT EXISTS idx_scan_runs_source
  ON scan_runs(source_id);

-- catalogue_entries.finding_id — uniqueness check and JOIN
CREATE INDEX IF NOT EXISTS idx_catalogue_finding
  ON catalogue_entries(finding_id);

-- catalogue_entries.scan_run_id — JOIN and publish lookup
CREATE INDEX IF NOT EXISTS idx_catalogue_scan_run
  ON catalogue_entries(scan_run_id);

-- ─────────────────────────────────────────────
-- QUERY-PATTERN INDEXES
-- ─────────────────────────────────────────────

-- scan_runs.status — WHERE status = 'running' / 'completed'
CREATE INDEX IF NOT EXISTS idx_scan_runs_status
  ON scan_runs(status);

-- findings.table_name — review page groups findings by table
CREATE INDEX IF NOT EXISTS idx_findings_table
  ON findings(table_name);

-- Composite: covers the publish query exactly
-- WHERE scan_run_id = ? AND review_status = 'confirmed' AND published = FALSE
CREATE INDEX IF NOT EXISTS idx_findings_scan_review_published
  ON findings(scan_run_id, review_status, published);

-- catalogue_entries.confirmed_at — ORDER BY confirmed_at DESC
CREATE INDEX IF NOT EXISTS idx_catalogue_confirmed_at
  ON catalogue_entries(confirmed_at DESC);

-- ─────────────────────────────────────────────
-- NOTE ON MULTI-TENANCY
-- This schema is single-tenant (one organisation per deployment).
-- For multi-tenancy, each table would need:
--   tenant_id UUID NOT NULL REFERENCES tenants(id)
--   Row-Level Security: CREATE POLICY ... USING (tenant_id = current_setting('app.tenant_id')::uuid)
--   All query indexes with tenant_id as the leading column
-- The UUID PKs make this straightforward to add later.
-- ─────────────────────────────────────────────
