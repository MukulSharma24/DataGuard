'use strict';

const { query }  = require('../config/database');
const { classifyFields } = require('../classifier/piiClassifier');
const { classifyTableWithLLM, mergeResults, isLLMEnabled } = require('../classifier/llmClassifier');
const pgConnector    = require('../connectors/postgresConnector');
const mongoConnector = require('../connectors/mongodbConnector');
const { getScanQueue, isQueueEnabled } = require('../queue/index');
const { cacheDel } = require('../utils/cache');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Cross-table awareness + retention helpers
// ---------------------------------------------------------------------------

// Categories that make a table "PII-bearing" — i.e. a foreign key pointing here
// indirectly identifies a person. Pure technical IDs/credentials don't count.
const PERSONAL_PII = new Set([
  'NAME', 'EMAIL', 'PHONE', 'ADDRESS', 'DOB', 'AADHAAR', 'PAN',
  'BANK_ACCOUNT', 'HEALTH', 'BIOMETRIC', 'SALARY', 'MARITAL',
  'NATIONALITY', 'RELIGION', 'GENDER',
]);

// Sentinel prefix on a finding's detection_reason that marks a cross-table link.
// The frontend keys off this to render a "Linked" badge.
const LINK_MARK = '🔗 Linked PII:';

const DAY_MS = 86_400_000;

// Build a retention record (oldest/newest + derived ages) from a raw date range.
function buildRetention(range) {
  if (!range || !range.oldest) return null;
  const oldest = new Date(range.oldest);
  const newest = new Date(range.newest ?? range.oldest);
  if (isNaN(oldest.getTime())) return null;
  const now = Date.now();
  return {
    oldest:   oldest.toISOString(),
    newest:   newest.toISOString(),
    column:   range.column,
    ageDays:  Math.max(0, Math.round((now - oldest.getTime()) / DAY_MS)),
    spanDays: Math.max(0, Math.round((newest.getTime() - oldest.getTime()) / DAY_MS)),
  };
}

// ---------------------------------------------------------------------------
// Cancellation registry
// ---------------------------------------------------------------------------

const _cancellations = new Set();

function cancelScan(scanRunId) { _cancellations.add(scanRunId); }
function isCancelled(scanRunId) { return _cancellations.has(scanRunId); }

// ---------------------------------------------------------------------------
// Global scan limits
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_SCANS = 5;          // max scans running at the same time
const SCAN_TIMEOUT_MS       = 30 * 60 * 1000; // 30 minutes — auto-cancel hung scans

// ---------------------------------------------------------------------------
// Concurrency limiter — run up to `limit` async tasks simultaneously
// ---------------------------------------------------------------------------

async function runWithConcurrency(tasks, limit) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const task = tasks[i++];
      await task();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SCAN_CONCURRENCY  = 4;
const MONGO_CONCURRENCY = 4;
// Max concurrent Gemini calls — prevents hitting free-tier RPM limits.
// Each slot does ~2-4s of LLM work, so 3 slots ≈ 45-90 RPM which fits paid tiers.
const LLM_CONCURRENCY   = 3;

// ---------------------------------------------------------------------------
// LLM semaphore — caps simultaneous Gemini calls across all concurrent tables
// ---------------------------------------------------------------------------

class Semaphore {
  constructor(n) { this._n = n; this._queue = []; }
  async acquire() {
    if (this._n > 0) { this._n--; return; }
    await new Promise(resolve => this._queue.push(resolve));
  }
  release() {
    this._n++;
    if (this._queue.length) { this._n--; this._queue.shift()(); }
  }
}
const _llmSem = new Semaphore(LLM_CONCURRENCY);

// ---------------------------------------------------------------------------
// Buffered logger — accumulates lines in memory, flushes to DB in one UPDATE
// every LOG_FLUSH_THRESHOLD lines or when flushLog() is called explicitly.
// Cuts ~150 individual UPDATE round-trips down to a handful per scan.
// ---------------------------------------------------------------------------

const LOG_FLUSH_THRESHOLD = 10;
const _logBuffers = new Map(); // scanRunId → string[]

async function appendLog(scanRunId, message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (!_logBuffers.has(scanRunId)) _logBuffers.set(scanRunId, []);
  const buf = _logBuffers.get(scanRunId);
  buf.push(line);
  if (buf.length >= LOG_FLUSH_THRESHOLD) await flushLog(scanRunId);
}

async function flushLog(scanRunId) {
  const buf = _logBuffers.get(scanRunId);
  if (!buf || buf.length === 0) return;
  _logBuffers.delete(scanRunId);
  await query(
    `UPDATE scan_runs SET log = log || $1 WHERE id = $2`,
    [buf.join('\n') + '\n', scanRunId]
  );
}

// ---------------------------------------------------------------------------
// Batch finding writer — single multi-row INSERT per table instead of N INSERTs.
// Eliminates the biggest source of round-trip overhead on remote app databases.
// ---------------------------------------------------------------------------

async function saveFindings(scanRunId, sourceId, findings, schema, table) {
  if (findings.length === 0) return;
  const placeholders = [];
  const params = [];
  let p = 1;
  for (const f of findings) {
    placeholders.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},$${p+9})`);
    params.push(
      scanRunId, sourceId, schema, table,
      f.fieldPath, f.piiCategory,
      f.confidenceScore, f.confidenceLevel,
      f.detectionReason, JSON.stringify(f.sampleValuesMasked)
    );
    p += 10;
  }
  await query(
    `INSERT INTO findings
       (scan_run_id, source_id, schema_name, table_name, field_path,
        pii_category, confidence_score, confidence_level,
        detection_reason, sample_values_masked)
     VALUES ${placeholders.join(',')}`,
    params
  );
}

async function updateScanStatus(scanRunId, status, counts = {}) {
  const TERMINAL = ['completed', 'failed', 'partial', 'cancelled'];
  const completedAt = TERMINAL.includes(status) ? new Date() : null;
  await query(
    `UPDATE scan_runs
     SET status            = $1,
         completed_at      = COALESCE($2, completed_at),
         tables_scanned    = COALESCE($3, tables_scanned),
         findings_count    = COALESCE($4, findings_count),
         error_message     = COALESCE($5, error_message),
         scan_duration_ms  = COALESCE($6, scan_duration_ms),
         rows_sampled      = COALESCE($7, rows_sampled),
         classifier_stats  = COALESCE($8, classifier_stats)
     WHERE id = $9`,
    [
      status, completedAt,
      counts.tables    ?? null,
      counts.findings  ?? null,
      counts.error     ?? null,
      counts.durationMs   ?? null,
      counts.rowsSampled  ?? null,
      counts.classifierStats ? JSON.stringify(counts.classifierStats) : null,
      scanRunId,
    ]
  );
}

// ---------------------------------------------------------------------------
// PostgreSQL scanner
// ---------------------------------------------------------------------------

async function scanPostgres(scanRunId, sourceId, connConfig, profileConfig) {
  const {
    includeSchemas = [],
    excludeSchemas = [],
    sampleSize     = 500,
    batchSize      = 20,
  } = profileConfig;

  let tablesScanned   = 0;
  let findingsCount   = 0;
  let rowsSampled     = 0;
  let partialFailure  = false;
  let relationships   = 0;
  const classifierStats = { patternDetected: 0, llmAdded: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
  const retention     = {};             // "schema.table" → retention record
  const tablePii      = new Map();      // "schema.table" → Set of personal PII categories
  const scannedTables = new Set();      // "schema.table" actually scanned this run

  const { rows: [sourceRow] } = await query(
    `SELECT last_scanned FROM data_sources WHERE id = $1`, [sourceId]
  );
  const lastScanned = sourceRow?.last_scanned ?? null;

  const pool = pgConnector.createPool(connConfig);

  try {
    await appendLog(scanRunId, 'Discovering PostgreSQL schemas…');
    const schemas = await pgConnector.discoverSchema(pool);

    // Foreign-key map powers cross-table awareness. Fail-soft: no FK info just
    // means relationship detection is skipped, the rest of the scan is unaffected.
    const foreignKeys = await pgConnector.discoverForeignKeys(pool).catch(() => []);
    if (foreignKeys.length > 0) {
      await appendLog(scanRunId, `Mapped ${foreignKeys.length} foreign-key relationship(s) for cross-table analysis`);
    }

    const filtered = schemas.filter(s => {
      if (includeSchemas.length > 0 && !includeSchemas.includes(s.schema)) return false;
      if (excludeSchemas.includes(s.schema)) return false;
      return true;
    });

    await appendLog(scanRunId, `Found ${filtered.length} schema(s): ${filtered.map(s => s.schema).join(', ')}`);

    for (const { schema, tables } of filtered) {
      if (isCancelled(scanRunId)) break;

      await appendLog(scanRunId, `Scanning schema: ${schema} (${tables.length} tables)`);

      const unchanged = await pgConnector.getUnchangedTables(
        pool, schema, tables.map(t => t.name), lastScanned
      );
      if (unchanged.size > 0) {
        await appendLog(scanRunId, `  ↷ Skipping ${unchanged.size} unchanged table(s): ${[...unchanged].join(', ')}`);
      }

      const scannable = tables.filter(t => !unchanged.has(t.name));

      const tableTasks = scannable.map(table => async () => {
        if (isCancelled(scanRunId)) return;

        try {
          await appendLog(scanRunId, `  → ${schema}.${table.name} (${table.columns.length} columns)`);

          const fieldSamples = await pgConnector.sampleTable(
            pool, schema, table.name, table.columns, batchSize, sampleSize
          );

          rowsSampled += fieldSamples.reduce((sum, f) => sum + f.samples.length, 0);

          const patternFindings = classifyFields(fieldSamples);
          let findings = patternFindings;
          classifierStats.patternDetected += patternFindings.length;

          if (isLLMEnabled()) {
            // Semaphore caps concurrent Gemini calls within RPM budget
            await _llmSem.acquire();
            try {
              // Pass pattern findings as hints so LLM confirms, refines, or catches misses
              const llmMap = await classifyTableWithLLM(schema, table.name, fieldSamples, patternFindings);
              findings = mergeResults(patternFindings, llmMap, fieldSamples);
              const llmAdded = Math.max(0, findings.length - patternFindings.length);
              classifierStats.llmAdded += llmAdded;
              if (llmAdded > 0) {
                await appendLog(scanRunId, `    🤖 LLM added ${llmAdded} additional finding(s)`);
              }
            } finally {
              _llmSem.release();
            }
          }

          // Single multi-row INSERT per table — eliminates N round-trips
          await saveFindings(scanRunId, sourceId, findings, schema, table.name);
          findingsCount += findings.length;
          const tableKey = `${schema}.${table.name}`;
          scannedTables.add(tableKey);
          for (const f of findings) {
            if (f.confidenceLevel === 'HIGH')   classifierStats.highCount++;
            if (f.confidenceLevel === 'MEDIUM') classifierStats.mediumCount++;
            if (f.confidenceLevel === 'LOW')    classifierStats.lowCount++;
            if (PERSONAL_PII.has(f.piiCategory)) {
              if (!tablePii.has(tableKey)) tablePii.set(tableKey, new Set());
              tablePii.get(tableKey).add(f.piiCategory);
            }
          }

          // Data retention — how old the records in this table actually are.
          // Runs after sampling so the dedicated sample connection is already
          // released; this just borrows a pooled connection for one MIN/MAX query.
          const range = await pgConnector
            .getTableDateRange(pool, schema, table.name, table.columns)
            .catch(() => null);
          const ret = buildRetention(range);
          if (ret) retention[tableKey] = ret;

          tablesScanned++;
          await appendLog(scanRunId, `    ✓ ${findings.length} PII field(s) found`);
        } catch (err) {
          partialFailure = true;
          await appendLog(scanRunId, `    ✗ Error scanning ${schema}.${table.name}: ${err.message}`);
          logger.warn(`Scan error in ${schema}.${table.name}`, { message: err.message, scanRunId });
        }
      });

      await runWithConcurrency(tableTasks, SCAN_CONCURRENCY);
      await flushLog(scanRunId); // flush buffered log lines after each schema wave
      tablesScanned += unchanged.size;
    }

    // ---- Cross-table awareness pass -------------------------------------
    // A foreign key pointing at a PII-bearing table is an indirect identifier.
    // For each such FK whose own table we scanned: annotate the existing finding,
    // or create one if the column slipped past name/value matching entirely.
    if (foreignKeys.length > 0 && tablePii.size > 0 && !isCancelled(scanRunId)) {
      for (const fk of foreignKeys) {
        const ownKey = `${fk.schema}.${fk.table}`;
        const refKey = `${fk.refSchema}.${fk.refTable}`;
        if (!scannedTables.has(ownKey)) continue;       // FK's table not in scope
        if (ownKey === refKey) continue;                // self-reference — skip
        const refCats = tablePii.get(refKey);
        if (!refCats) continue;                          // referenced table has no PII

        const cats = [...refCats].join(', ');
        const refName = fk.refSchema === 'public' ? fk.refTable : refKey;
        const note = `${LINK_MARK} foreign key → "${refName}" which holds ${cats}; indirectly identifies individuals.`;

        try {
          const { rowCount } = await query(
            `UPDATE findings
               SET detection_reason = detection_reason || $1
             WHERE scan_run_id = $2 AND schema_name = $3
               AND table_name = $4 AND field_path = $5
               AND detection_reason NOT LIKE '%' || $6 || '%'`,
            [`  ${note}`, scanRunId, fk.schema, fk.table, fk.column, LINK_MARK]
          );

          if (rowCount === 0) {
            // Column wasn't flagged on its own — record it as an indirect identifier
            await query(
              `INSERT INTO findings
                 (scan_run_id, source_id, schema_name, table_name, field_path,
                  pii_category, confidence_score, confidence_level,
                  detection_reason, sample_values_masked)
               VALUES ($1,$2,$3,$4,$5,'USER_ID',60,'MEDIUM',$6,'[]'::jsonb)`,
              [scanRunId, sourceId, fk.schema, fk.table, fk.column, note]
            );
            findingsCount++;
            classifierStats.mediumCount++;
          }
          relationships++;
        } catch (err) {
          logger.warn(`Cross-table enrichment failed for ${ownKey}.${fk.column}`, { message: err.message });
        }
      }

      if (relationships > 0) {
        await appendLog(scanRunId, `  🔗 Flagged ${relationships} indirect identifier(s) via foreign keys to PII-bearing tables`);
        await flushLog(scanRunId);
      }
    }
  } finally {
    await pool.end().catch(() => {});
  }

  classifierStats.retention     = retention;
  classifierStats.relationships = relationships;
  return { tablesScanned, findingsCount, rowsSampled, classifierStats, partialFailure };
}

// ---------------------------------------------------------------------------
// MongoDB scanner
// ---------------------------------------------------------------------------

async function scanMongodb(scanRunId, sourceId, connConfig, profileConfig) {
  const {
    includeCollections = [],
    excludeCollections = [],
  } = profileConfig;

  let tablesScanned  = 0;
  let findingsCount  = 0;
  let rowsSampled    = 0;
  let partialFailure = false;
  const classifierStats = { patternDetected: 0, llmAdded: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
  const retention = {};   // "default.collection" → retention record

  await appendLog(scanRunId, 'Discovering MongoDB collections…');
  let collections;
  try {
    collections = await mongoConnector.discoverCollections(connConfig);
  } catch (err) {
    await appendLog(scanRunId, `FATAL: Could not connect to MongoDB — ${err.message}`);
    throw err;
  }

  const filtered = collections.filter(c => {
    if (includeCollections.length > 0 && !includeCollections.includes(c.name)) return false;
    if (excludeCollections.includes(c.name)) return false;
    return true;
  });

  await appendLog(scanRunId, `Found ${filtered.length} collection(s): ${filtered.map(c => c.name).join(', ')}`);

  const collectionTasks = filtered.map(collection => async () => {
    if (isCancelled(scanRunId)) return;

    try {
      if (collection.error) throw new Error(collection.error);
      if (collection.fields.length === 0) {
        await appendLog(scanRunId, `  → ${collection.name}: empty, skipped`);
        return;
      }

      rowsSampled += collection.fields.reduce((sum, f) => sum + (f.samples?.length ?? 0), 0);

      await appendLog(scanRunId, `  → ${collection.name} (${collection.fields.length} field paths)`);

      const patternFindings = classifyFields(collection.fields);
      let findings = patternFindings;
      classifierStats.patternDetected += patternFindings.length;

      if (isLLMEnabled()) {
        await _llmSem.acquire();
        try {
          const llmMap = await classifyTableWithLLM('default', collection.name, collection.fields, patternFindings);
          findings = mergeResults(patternFindings, llmMap, collection.fields);
          const llmAdded = Math.max(0, findings.length - patternFindings.length);
          classifierStats.llmAdded += llmAdded;
          if (llmAdded > 0) {
            await appendLog(scanRunId, `    🤖 LLM added ${llmAdded} additional finding(s)`);
          }
        } finally {
          _llmSem.release();
        }
      }

      // Data retention — derived from _id ObjectId timestamps by the connector
      const ret = buildRetention(collection.dateRange);
      if (ret) retention[`default.${collection.name}`] = ret;

      // Single multi-row INSERT per collection
      await saveFindings(scanRunId, sourceId, findings, 'default', collection.name);
      findingsCount += findings.length;
      for (const f of findings) {
        if (f.confidenceLevel === 'HIGH')   classifierStats.highCount++;
        if (f.confidenceLevel === 'MEDIUM') classifierStats.mediumCount++;
        if (f.confidenceLevel === 'LOW')    classifierStats.lowCount++;
      }

      tablesScanned++;
      await appendLog(scanRunId, `    ✓ ${findings.length} PII field(s) found`);
    } catch (err) {
      partialFailure = true;
      await appendLog(scanRunId, `    ✗ Error scanning collection ${collection.name}: ${err.message}`);
      logger.warn(`Scan error in collection ${collection.name}`, { message: err.message, scanRunId });
    }
  });

  await runWithConcurrency(collectionTasks, MONGO_CONCURRENCY);
  await flushLog(scanRunId);

  classifierStats.retention     = retention;
  classifierStats.relationships = 0;   // MongoDB has no declared foreign keys
  return { tablesScanned, findingsCount, rowsSampled, classifierStats, partialFailure };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function triggerScan(profileId, sourceId, connConfig, sourceType, profileConfig = {}) {
  // Reject if too many scans are already running — prevents pool exhaustion
  const { rows: running } = await query(
    `SELECT COUNT(*) AS cnt FROM scan_runs WHERE status = 'running'`
  );
  if (parseInt(running[0].cnt, 10) >= MAX_CONCURRENT_SCANS) {
    const err = new Error(`Too many scans running (max ${MAX_CONCURRENT_SCANS}). Wait for one to finish before starting another.`);
    err.status = 429;
    throw err;
  }

  const { rows } = await query(
    `INSERT INTO scan_runs (profile_id, source_id, status, started_at)
     VALUES ($1, $2, 'running', NOW())
     RETURNING id`,
    [profileId, sourceId]
  );
  const scanRunId = rows[0].id;

  logger.info(`Scan run ${scanRunId} started`, { profileId, sourceId, sourceType });

  const queue = getScanQueue();
  if (queue) {
    await queue.add('run-scan', { scanRunId, profileId, sourceId, sourceType });
    logger.info(`Scan ${scanRunId} enqueued via BullMQ`);
  } else {
    // In-process fallback — auto-cancel if scan exceeds timeout
    const timeoutHandle = setTimeout(() => {
      logger.warn(`Scan ${scanRunId} exceeded ${SCAN_TIMEOUT_MS / 60000}min timeout — auto-cancelling`);
      cancelScan(scanRunId);
    }, SCAN_TIMEOUT_MS);

    setImmediate(() =>
      runScan(scanRunId, sourceId, connConfig, sourceType, profileConfig)
        .finally(() => clearTimeout(timeoutHandle))
    );
  }

  return scanRunId;
}

// Exported so the BullMQ worker can call it directly
async function runScan(scanRunId, sourceId, connConfig, sourceType, profileConfig) {
  const startTime = Date.now();
  try {
    const llmStatus = isLLMEnabled()
      ? 'LLM: enabled (gemini-2.5-flash)'
      : 'LLM: disabled';
    const queueStatus = isQueueEnabled() ? 'queue: BullMQ' : 'queue: in-process';
    await appendLog(scanRunId, `Scan started — ${sourceType} | ${llmStatus} | ${queueStatus} | parallelism: ${SCAN_CONCURRENCY}x`);

    let result;
    if (sourceType === 'postgresql') {
      result = await scanPostgres(scanRunId, sourceId, connConfig, profileConfig);
    } else if (sourceType === 'mongodb') {
      result = await scanMongodb(scanRunId, sourceId, connConfig, profileConfig);
    } else {
      throw new Error(`Unknown source type: ${sourceType}`);
    }

    const durationMs = Date.now() - startTime;
    const rowsPerSec = durationMs > 0
      ? Math.round((result.rowsSampled / durationMs) * 1000)
      : 0;

    if (isCancelled(scanRunId)) {
      _cancellations.delete(scanRunId);
      await updateScanStatus(scanRunId, 'cancelled', {
        tables:           result.tablesScanned,
        findings:         result.findingsCount,
        durationMs,
        rowsSampled:      result.rowsSampled,
        classifierStats:  result.classifierStats,
      });
      await appendLog(scanRunId, `Scan cancelled — ${result.tablesScanned} table(s) before stop`);
      return;
    }

    _cancellations.delete(scanRunId);
    const finalStatus = result.partialFailure ? 'partial' : 'completed';
    await updateScanStatus(scanRunId, finalStatus, {
      tables:           result.tablesScanned,
      findings:         result.findingsCount,
      durationMs,
      rowsSampled:      result.rowsSampled,
      classifierStats:  result.classifierStats,
    });

    await query(`UPDATE data_sources SET last_scanned = NOW() WHERE id = $1`, [sourceId]);

    // Invalidate cached stats so the dashboard reflects the new scan immediately
    await cacheDel('catalogue:stats', 'sources:list');

    await appendLog(scanRunId,
      `Scan ${finalStatus} — ${result.tablesScanned} table(s), ${result.findingsCount} finding(s), ` +
      `${result.rowsSampled} rows sampled, ${rowsPerSec} rows/sec, ${durationMs}ms`
    );
    await flushLog(scanRunId); // ensure final summary line is persisted
    logger.info(`Scan run ${scanRunId} ${finalStatus}`, {
      tablesScanned:   result.tablesScanned,
      findingsCount:   result.findingsCount,
      rowsSampled:     result.rowsSampled,
      rowsPerSec,
      durationMs,
      classifierStats: result.classifierStats,
    });
  } catch (err) {
    _cancellations.delete(scanRunId);
    logger.error(`Scan run ${scanRunId} failed`, { message: err.message });
    await updateScanStatus(scanRunId, 'failed', { error: err.message }).catch(() => {});
    await appendLog(scanRunId, `FATAL: ${err.message}`).catch(() => {});
    await flushLog(scanRunId).catch(() => {}); // flush error line even on crash path
  }
}

module.exports = { triggerScan, cancelScan, runScan };
