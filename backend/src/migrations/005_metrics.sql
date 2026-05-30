-- Migration 005: Scan metrics columns
-- Tracks scan duration, rows sampled, and per-scan classifier breakdown.
-- All columns are nullable so existing rows are unaffected.

ALTER TABLE scan_runs
  ADD COLUMN IF NOT EXISTS scan_duration_ms  INTEGER,
  ADD COLUMN IF NOT EXISTS rows_sampled      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS classifier_stats  JSONB;

-- Index for dashboard queries: "average scan duration by source type"
CREATE INDEX IF NOT EXISTS idx_scan_runs_duration
  ON scan_runs(scan_duration_ms)
  WHERE scan_duration_ms IS NOT NULL;
