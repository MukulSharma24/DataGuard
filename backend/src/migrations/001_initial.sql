-- DataGuard Application Database Schema
-- All timestamps are UTC. UUIDs are used as primary keys.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────
-- DATA SOURCES
-- Stores connection details for target databases
-- to be scanned. Credentials are AES-256 encrypted
-- by the application before being persisted here.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_sources (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(255)  NOT NULL,
  type             VARCHAR(50)   NOT NULL CHECK (type IN ('postgresql', 'mongodb')),
  -- Encrypted JSON: { host, port, database, user, password, connectionString }
  connection_config TEXT          NOT NULL,
  status           VARCHAR(50)   NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'inactive', 'error')),
  last_scanned     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- SCAN PROFILES
-- Reusable configuration: which schemas/collections
-- to include, sample size, scan name, etc.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scan_profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   UUID          NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  name        VARCHAR(255)  NOT NULL,
  description TEXT,
  -- JSON: { includeSchemas, excludeSchemas, includeCollections,
  --         excludeCollections, sampleSize, batchSize }
  config      JSONB         NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- SCAN RUNS
-- A single execution of a scan profile.
-- Logs are appended incrementally during the run.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scan_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id   UUID          NOT NULL REFERENCES scan_profiles(id) ON DELETE CASCADE,
  source_id    UUID          NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  status       VARCHAR(50)   NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'completed', 'failed', 'partial')),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  -- Summary counts updated at completion
  tables_scanned   INT NOT NULL DEFAULT 0,
  findings_count   INT NOT NULL DEFAULT 0,
  error_message    TEXT,
  -- Append-only scan log (newline-separated entries)
  log          TEXT          NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- FINDINGS
-- One row per (scan_run, field_path) where PII
-- was detected. review_status drives the workflow:
-- unreviewed → confirmed | rejected | reclassified
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS findings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id           UUID          NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  source_id             UUID          NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  -- For PostgreSQL: schema name. For MongoDB: 'default'
  schema_name           VARCHAR(255)  NOT NULL DEFAULT 'default',
  -- Table name (PG) or collection name (Mongo)
  table_name            VARCHAR(255)  NOT NULL,
  -- Column name (PG) or dot-path field (Mongo, e.g. user.contact.email)
  field_path            VARCHAR(512)  NOT NULL,
  pii_category          VARCHAR(50)   NOT NULL,
  confidence_score      SMALLINT      NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  confidence_level      VARCHAR(10)   NOT NULL CHECK (confidence_level IN ('HIGH', 'MEDIUM', 'LOW')),
  -- Human-readable explanation of why this was flagged
  detection_reason      TEXT          NOT NULL,
  -- Up to 3 sample values, masked (e.g. "j***@example.com")
  sample_values_masked  JSONB         NOT NULL DEFAULT '[]',
  -- Workflow
  review_status         VARCHAR(20)   NOT NULL DEFAULT 'unreviewed'
                          CHECK (review_status IN ('unreviewed', 'confirmed', 'rejected', 'reclassified')),
  review_note           TEXT,
  reviewed_at           TIMESTAMPTZ,
  reviewed_by           VARCHAR(255),
  -- Set to true when finding is published to the catalogue
  published             BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_findings_scan_run    ON findings(scan_run_id);
CREATE INDEX IF NOT EXISTS idx_findings_source      ON findings(source_id);
CREATE INDEX IF NOT EXISTS idx_findings_category    ON findings(pii_category);
CREATE INDEX IF NOT EXISTS idx_findings_review      ON findings(review_status);
CREATE INDEX IF NOT EXISTS idx_findings_published   ON findings(published);

-- ─────────────────────────────────────────────
-- CATALOGUE ENTRIES
-- Immutable record of a published finding.
-- Populated explicitly via the publish API.
-- Never stores raw PII — field paths and metadata only.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalogue_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id    UUID          NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  scan_run_id   UUID          NOT NULL REFERENCES scan_runs(id),
  source_id     UUID          NOT NULL REFERENCES data_sources(id),
  source_name   VARCHAR(255)  NOT NULL,
  source_type   VARCHAR(50)   NOT NULL,
  schema_name   VARCHAR(255)  NOT NULL DEFAULT 'default',
  table_name    VARCHAR(255)  NOT NULL,
  field_path    VARCHAR(512)  NOT NULL,
  pii_category  VARCHAR(50)   NOT NULL,
  confidence_level VARCHAR(10) NOT NULL,
  purpose       VARCHAR(255),
  owner         VARCHAR(255),
  confirmed_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  scan_run_id_ref UUID -- denormalised for fast lookup
);

CREATE INDEX IF NOT EXISTS idx_catalogue_source   ON catalogue_entries(source_id);
CREATE INDEX IF NOT EXISTS idx_catalogue_category ON catalogue_entries(pii_category);

-- ─────────────────────────────────────────────
-- HELPER: auto-update updated_at
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_data_sources_updated_at ON data_sources;
CREATE TRIGGER trg_data_sources_updated_at
  BEFORE UPDATE ON data_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_scan_profiles_updated_at ON scan_profiles;
CREATE TRIGGER trg_scan_profiles_updated_at
  BEFORE UPDATE ON scan_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
