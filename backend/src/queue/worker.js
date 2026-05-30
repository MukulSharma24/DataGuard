'use strict';

/**
 * BullMQ worker — runs in the same process for development simplicity.
 *
 * Production upgrade path:
 *   Extract this file into a standalone process: `node src/queue/worker.js`
 *   Scale horizontally by running N worker processes pointing at the same Redis.
 *   Each job is processed by exactly one worker (BullMQ handles locking).
 */

const { Worker } = require('bullmq');
const { query }  = require('../config/database');
const { decrypt } = require('../utils/crypto');
const { runScan } = require('../scanner/scanEngine');
const { getConnection } = require('./index');
const logger = require('../utils/logger');

function startScanWorker() {
  const connection = getConnection();
  if (!connection) {
    logger.info('Redis not configured — scan worker not started (in-process fallback active)');
    return null;
  }

  const worker = new Worker(
    'dataguard-scans',
    async (job) => {
      const { scanRunId, profileId, sourceId, sourceType } = job.data;

      // Re-fetch credentials from DB — NEVER stored in Redis payloads (security)
      const { rows } = await query(
        `SELECT p.config, s.connection_config
         FROM scan_profiles p
         JOIN data_sources  s ON s.id = p.source_id
         WHERE p.id = $1`,
        [profileId]
      );

      if (!rows.length) throw new Error(`Profile ${profileId} not found`);

      const connConfig    = JSON.parse(decrypt(rows[0].connection_config));
      const profileConfig = rows[0].config || {};

      // Report progress so the frontend polling can show job position
      await job.updateProgress(10);
      logger.info(`Worker processing scan job`, { scanRunId, jobId: job.id });

      await runScan(scanRunId, sourceId, connConfig, sourceType, profileConfig);
      await job.updateProgress(100);
    },
    {
      connection,
      concurrency: 3,          // max 3 scans running simultaneously per worker process
      limiter: {
        max:      5,           // max 5 jobs processed per duration window
        duration: 60_000,      // per minute — prevents overloading the target DBs
      },
    }
  );

  worker.on('completed', job => {
    logger.info(`Scan job completed`, { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error(`Scan job failed`, { jobId: job?.id, message: err.message });
  });

  worker.on('error', err => {
    logger.error('Worker error', { message: err.message });
  });

  logger.info('BullMQ scan worker started (concurrency: 3)');
  return worker;
}

// Allow running as a standalone process: node src/queue/worker.js
if (require.main === module) {
  require('dotenv').config();
  startScanWorker();
  logger.info('Standalone worker process running — waiting for jobs');
}

module.exports = { startScanWorker };
