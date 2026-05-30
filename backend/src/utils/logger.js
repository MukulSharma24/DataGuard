'use strict';

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

function format(level, message, meta) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level}] ${message}`;
  if (!meta || Object.keys(meta).length === 0) return base;
  // Strip any credential-looking keys before logging
  const safe = Object.fromEntries(
    Object.entries(meta).filter(([k]) => !/password|secret|key|token|credential|auth/i.test(k))
  );
  return `${base} ${JSON.stringify(safe)}`;
}

const logger = {
  error: (msg, meta = {}) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.ERROR) console.error(format('ERROR', msg, meta));
  },
  warn: (msg, meta = {}) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.WARN) console.warn(format('WARN', msg, meta));
  },
  info: (msg, meta = {}) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.INFO) console.info(format('INFO', msg, meta));
  },
  debug: (msg, meta = {}) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.DEBUG) console.debug(format('DEBUG', msg, meta));
  },
};

module.exports = logger;
