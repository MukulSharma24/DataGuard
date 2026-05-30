'use strict';

const { Queue } = require('bullmq');
const IORedis   = require('ioredis');
const logger    = require('../utils/logger');

// Single shared Redis connection — reused by queue, worker, and cache
let _connection = null;
let _scanQueue  = null;

function getConnection() {
  if (_connection) return _connection;
  if (!process.env.REDIS_URL) return null;

  _connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
  });

  _connection.on('error', err => {
    logger.warn('Redis connection error — queue features unavailable', { message: err.message });
  });

  return _connection;
}

function getScanQueue() {
  const conn = getConnection();
  if (!conn) return null;

  if (!_scanQueue) {
    _scanQueue = new Queue('dataguard-scans', {
      connection: conn,
      defaultJobOptions: {
        attempts:          1,                          // no retry — scan_run_id is reused and re-inserting findings hits unique constraint
        removeOnComplete:  { count: 100 },             // keep last 100 finished jobs
        removeOnFail:      { count: 50 },
      },
    });
    logger.info('BullMQ scan queue initialised');
  }

  return _scanQueue;
}

function isQueueEnabled() {
  return !!process.env.REDIS_URL;
}

module.exports = { getConnection, getScanQueue, isQueueEnabled };
