'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[process.env.LOG_LEVEL] || (config.isProd ? LEVELS.info : LEVELS.debug);

let stream = null;
function fileStream() {
  if (!stream) {
    stream = fs.createWriteStream(path.join(config.paths.logs, 'app.log'), { flags: 'a' });
  }
  return stream;
}

function write(level, scope, message, meta) {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString();
  const metaStr = meta === undefined ? '' : ' ' + safeStringify(meta);
  const line = `${ts} [${level.toUpperCase()}] [${scope}] ${message}${metaStr}`;

  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(line);
  try {
    fileStream().write(line + '\n');
  } catch (_) { /* logging tidak boleh menjatuhkan proses */ }
}

function safeStringify(value) {
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function createLogger(scope) {
  return {
    debug: (msg, meta) => write('debug', scope, msg, meta),
    info: (msg, meta) => write('info', scope, msg, meta),
    warn: (msg, meta) => write('warn', scope, msg, meta),
    error: (msg, meta) => write('error', scope, msg, meta),
  };
}

module.exports = { createLogger };
