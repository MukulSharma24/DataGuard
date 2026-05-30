'use strict';

const logger = require('../utils/logger');

// Central error handler — registered last in Express middleware chain.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  logger.error('Unhandled error', {
    method:  req.method,
    path:    req.path,
    status,
    message: err.message,
    // Never log the stack in production — too much info leakage
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });

  res.status(status).json({
    error: status < 500 ? err.message : 'Internal server error',
  });
}

module.exports = errorHandler;
