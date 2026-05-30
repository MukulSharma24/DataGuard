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
// Cancellation registry
// ---------------------------------------------------------------------------

const _cancellations = new Set();

function cancelScan(scanRunId) { _cancellations.add(scanRunId); }
function isCancelled(scanRunId) { return _cancellations.has(scanRunId); }

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

const SCAN_CONCURRENCY = 4;

async function appendLog(scanRunId, message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  await query(
    `UPDATE scan_runs SET log = log || $1 || E'\n' WHERE id = $2`,
    [line, scanRunId]
  );
}

async function saveFinding(scanRunId, sourceId, finding, schema, table) {
  await query(
    `INSERT INTO findings
       (scan_run_id, source_id, schema_name, table_name, field_path,
        pii_category, confidence_score, confidence_level,
        detection_reason, sample_values_masked)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      scanRunId, sourceId, schema, table,
      finding.fieldPath, finding.piiCategory,
      finding.confidenceScore, finding.confidenceLevel,
      finding.detectionReason,
      JSON.stringify(finding.sampleValuesMasked),
    ]
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
    sampleSize     = 100,
    batchSize      = 20,
  } = profileConfig;

  let tablesScanned   = 0;
  let findingsCount   = 0;
  let rowsSampled     = 0;
  let partialFailure  = false;
  const classifierStats = { patternDetected: 0, llmAdded: 0, highCount: 0, mediumCount: 0, lowCount: 0 };

  const { rows: [sourceRow] } = await query(
    `SELECT last_scanned FROM data_sources WHERE id = $1`, [sourceId]
  );
  const lastScanned = sourceRow?.last_scanned ?? null;

  const pool = pgConnector.createPool(connConfig);

  try {
    await appendLog(scanRunId, 'Discovering PostgreSQL schemas…');
    const schemas = await pgConnector.discoverSchema(pool);

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

          // Track rows sampled for metrics
          rowsSampled += fieldSamples.reduce((sum, f) => sum + f.samples.length, 0);

          const patternFindings = classifyFields(fieldSamples);
          let findings = patternFindings;
          classifierStats.patternDetected += patternFindings.length;

          if (isLLMEnabled()) {
            const llmMap = await classifyTableWithLLM(schema, table.name, fieldSamples);
            findings = mergeResults(patternFindings, llmMap, fieldSamples);
            // Net new findings added by LLM. Can be negative when LLM correctly drops
            // LOW-confidence false positives — clamp to 0 so the stat stays meaningful.
            const llmAdded = Math.max(0, findings.length - patternFindings.length);
            classifierStats.llmAdded += llmAdded;
            if (llmAdded > 0) {
              await appendLog(scanRunId, `    🤖 LLM added ${llmAdded} additional finding(s)`);
            }
          }

          for (const finding of findings) {
            await saveFinding(scanRunId, sourceId, finding, schema, table.name);
            findingsCount++;
            if (finding.confidenceLevel === 'HIGH')   classifierStats.highCount++;
            if (finding.confidenceLevel === 'MEDIUM') classifierStats.mediumCount++;
            if (finding.confidenceLevel === 'LOW')    classifierStats.lowCount++;
          }

          tablesScanned++;
          await appendLog(scanRunId, `    ✓ ${findings.length} PII field(s) found`);
        } catch (err) {
          partialFailure = true;
          await appendLog(scanRunId, `    ✗ Error scanning ${schema}.${table.name}: ${err.message}`);
          logger.warn(`Scan error in ${schema}.${table.name}`, { message: err.message, scanRunId });
        }
      });

      await runWithConcurrency(tableTasks, SCAN_CONCURRENCY);
      tablesScanned += unchanged.size;
    }
  } finally {
    await pool.end().catch(() => {});
  }

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

  for (const collection of filtered) {
    if (isCancelled(scanRunId)) break;

    try {
      if (collection.error) throw new Error(collection.error);
      if (collection.fields.length === 0) {
        await appendLog(scanRunId, `  → ${collection.name}: empty, skipped`);
        continue;
      }

      rowsSampled += collection.fields.reduce((sum, f) => sum + (f.samples?.length ?? 0), 0);

      await appendLog(scanRunId, `  → ${collection.name} (${collection.fields.length} field paths)`);

      const patternFindings = classifyFields(collection.fields);
      let findings = patternFindings;
      classifierStats.patternDetected += patternFindings.length;

      if (isLLMEnabled()) {
        const llmMap = await classifyTableWithLLM('default', collection.name, collection.fields);
        findings = mergeResults(patternFindings, llmMap, collection.fields);
        const llmAdded = Math.max(0, findings.length - patternFindings.length);
        classifierStats.llmAdded += llmAdded;
        if (llmAdded > 0) {
          await appendLog(scanRunId, `    🤖 LLM added ${llmAdded} additional finding(s)`);
        }
      }

      for (const finding of findings) {
        await saveFinding(scanRunId, sourceId, finding, 'default', collection.name);
        findingsCount++;
        if (finding.confidenceLevel === 'HIGH')   classifierStats.highCount++;
        if (finding.confidenceLevel === 'MEDIUM') classifierStats.mediumCount++;
        if (finding.confidenceLevel === 'LOW')    classifierStats.lowCount++;
      }

      tablesScanned++;
      await appendLog(scanRunId, `    ✓ ${findings.length} PII field(s) found`);
    } catch (err) {
      partialFailure = true;
      await appendLog(scanRunId, `    ✗ Error scanning collection ${collection.name}: ${err.message}`);
      logger.warn(`Scan error in collection ${collection.name}`, { message: err.message, scanRunId });
    }
  }

  return { tablesScanned, findingsCount, rowsSampled, classifierStats, partialFailure };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function triggerScan(profileId, sourceId, connConfig, sourceType, profileConfig = {}) {
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
    // BullMQ path: credentials are NOT passed to Redis — worker re-fetches from DB
    await queue.add('run-scan', { scanRunId, profileId, sourceId, sourceType });
    logger.info(`Scan ${scanRunId} enqueued via BullMQ`);
  } else {
    // In-process fallback when Redis is not configured
    setImmediate(() => runScan(scanRunId, sourceId, connConfig, sourceType, profileConfig));
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
  }
}

module.exports = { triggerScan, cancelScan, runScan };
