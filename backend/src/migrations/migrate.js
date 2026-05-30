'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { query, testConnection } = require('../config/database');
const logger = require('../utils/logger');

const MIGRATIONS = [
  '001_initial.sql',
  '002_indexes_and_constraints.sql',
  '003_performance_and_rest.sql',
  '005_metrics.sql',
  '006_users.sql',
];

async function run() {
  logger.info('Running database migrations...');

  await testConnection();
  logger.info('App database connection OK');

  for (const file of MIGRATIONS) {
    const sqlFile = path.join(__dirname, file);
    const sql     = fs.readFileSync(sqlFile, 'utf8');
    await query(sql);
    logger.info(`Migration ${file} applied successfully`);
  }
}

run()
  .then(() => {
    logger.info('All migrations complete');
    process.exit(0);
  })
  .catch((err) => {
    logger.error('Migration failed', { message: err.message });
    process.exit(1);
  });
