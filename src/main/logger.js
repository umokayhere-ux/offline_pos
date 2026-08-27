'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal file logger.
 *
 * Technical detail belongs here, not in front of a customer at the counter. The
 * log rotates at 2MB so it can never fill a shop PC's disk.
 */

const MAX_BYTES = 2 * 1024 * 1024;
let logFile = null;

function configure(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    logFile = path.join(directory, 'ittek-pos.log');
    rotateIfNeeded();
  } catch {
    logFile = null;
  }
}

function rotateIfNeeded() {
  try {
    if (!logFile || !fs.existsSync(logFile)) return;
    if (fs.statSync(logFile).size < MAX_BYTES) return;
    fs.renameSync(logFile, `${logFile}.1`);
  } catch { /* logging must never break the application */ }
}

function write(level, message, detail) {
  const line = `${new Date().toISOString()} [${level}] ${message}${detail ? ` :: ${format(detail)}` : ''}\n`;
  if (level === 'ERROR') process.stderr.write(line);
  else if (process.env.NODE_ENV === 'development') process.stdout.write(line);
  try {
    if (logFile) fs.appendFileSync(logFile, line);
  } catch { /* ignore */ }
}

function format(detail) {
  if (detail instanceof Error) return `${detail.message}\n${detail.stack || ''}`;
  if (typeof detail === 'string') return detail;
  try { return JSON.stringify(detail); } catch { return String(detail); }
}

module.exports = {
  configure,
  info: (message, detail) => write('INFO', message, detail),
  warn: (message, detail) => write('WARN', message, detail),
  error: (message, detail) => write('ERROR', message, detail),
  getLogFile: () => logFile
};
