'use strict';
// Per-user settings (settings.json) and a size-capped diagnostic log, both
// under %LOCALAPPDATA%\MermaidViewEdit. Never log diagram contents.

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_RECENT = 10;

const createLogger = (logDir) => {
  const file = path.join(logDir, 'app.log');
  const write = (level, message) => {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.renameSync(file, path.join(logDir, 'app.old.log'));
      }
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${message}\n`);
    } catch {
      // Logging must never take the app down.
    }
  };
  return {
    error: (message) => write('ERROR', message),
    file,
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message)
  };
};

const createSettings = (dataDir) => {
  const file = path.join(dataDir, 'settings.json');
  let data = { recentFiles: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') data = { ...data, ...parsed };
  } catch {
    // Missing or corrupt settings fall back to defaults.
  }
  if (!Array.isArray(data.recentFiles)) data.recentFiles = [];

  const save = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(data, undefined, 2));
      fs.renameSync(temp, file);
    } catch {
      // Settings are a convenience; failure to save is not fatal.
    }
  };

  return {
    addRecent(filePath) {
      data.recentFiles = [
        filePath,
        ...data.recentFiles.filter((p) => p.toLowerCase() !== filePath.toLowerCase())
      ].slice(0, MAX_RECENT);
      save();
    },
    clearRecent() {
      data.recentFiles = [];
      save();
    },
    file,
    get(key) {
      return data[key];
    },
    get recentFiles() {
      return [...data.recentFiles];
    },
    set(key, value) {
      data[key] = value;
      save();
    }
  };
};

module.exports = { createLogger, createSettings };
