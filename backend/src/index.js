'use strict';

require('dotenv').config();
require('express-async-errors');

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');

const cookieParser = require('cookie-parser');
const logger       = require('./utils/logger');
const { testConnection } = require('./config/database');
const errorHandler = require('./middleware/errorHandler');
const { authenticate, authorize } = require('./middleware/authenticate');
const { startScanWorker } = require('./queue/worker');

const authRouter      = require('./routes/auth');
const sourcesRouter   = require('./routes/sources');
const profilesRouter  = require('./routes/profiles');
const scansRouter     = require('./routes/scans');
const findingsRouter  = require('./routes/findings');
const catalogueRouter = require('./routes/catalogue');

// ─────────────────────────────────────────────
// App setup
// ─────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT || '4000', 10);

// Security headers
app.use(helmet());

// CORS — allow the frontend origin
app.use(cors({
  origin:      process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));

// HTTP request logging (skip in test)
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}

// Body parsing + cookie parsing
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Rate limiting — general API cap + tighter cap on scan triggers
const apiLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             2000,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests — please try again later' },
});

const scanLimiter = rateLimit({
  windowMs:       60 * 1000,       // 1 minute
  max:            10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:        { error: 'Too many scan requests — wait before triggering another' },
});

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    const dbTime = await testConnection();
    res.json({ status: 'ok', db: 'connected', serverTime: dbTime });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'unavailable', error: err.message });
  }
});

// Auth routes — public (login, logout, register, me)
// Generous limit for demos — auth requests are cheap and low-risk at this scale
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             1000,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests — please try again later' },
});
app.use('/api/auth', authLimiter, authRouter);

// All other /api/* routes require a valid JWT
app.use('/api', authenticate);
app.use('/api', apiLimiter);

// Write operations (POST/PATCH/PUT/DELETE) require admin role.
// GET requests are allowed for both viewer and admin.
app.use('/api', (req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    return authorize('admin')(req, res, next);
  }
  next();
});

// Tighter rate limit on scan creation only
app.use('/api/scans', (req, _res, next) => {
  if (req.method === 'POST') return scanLimiter(req, _res, next);
  next();
});

app.use('/api/sources',   sourcesRouter);
app.use('/api/profiles',  profilesRouter);
app.use('/api/scans',     scansRouter);
app.use('/api/findings',  findingsRouter);
app.use('/api/catalogue', catalogueRouter);

// 404 handler
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// Central error handler (must be last)
app.use(errorHandler);

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
async function start() {
  if (!process.env.JWT_SECRET) {
    logger.error('JWT_SECRET is not set — all authenticated requests will fail. Set it in .env');
    process.exit(1);
  }

  try {
    await testConnection();
    logger.info('App database connection verified');
  } catch (err) {
    logger.error('Cannot connect to app database — is it running?', { message: err.message });
    process.exit(1);
  }

  // Pre-warm the connection pool so the first real request doesn't pay
  // the TCP + auth handshake cost (~90ms per connection on localhost).
  // We open 3 connections eagerly and release them back to the pool.
  try {
    const { getPool } = require('./config/database');
    const pool = getPool();
    const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    clients.forEach(c => c.release());
    logger.info('Connection pool pre-warmed (3 connections ready)');
  } catch {
    // Non-fatal — pool will warm on first request instead
  }

  // Mark any scan that was left in 'running' state (server crashed mid-scan)
  try {
    const { query: dbQuery } = require('./config/database');
    const { rowCount } = await dbQuery(
      `UPDATE scan_runs
       SET status = 'failed', error_message = 'Server restarted while scan was running'
       WHERE status = 'running'`
    );
    if (rowCount > 0) logger.warn(`Marked ${rowCount} stuck scan(s) as failed on startup`);
  } catch {
    // Non-fatal
  }

  // Start the BullMQ worker (no-op if REDIS_URL not set)
  startScanWorker();

  app.listen(PORT, () => {
    logger.info(`DataGuard API listening on port ${PORT}`);
  });
}

start();

module.exports = app; // for testing
