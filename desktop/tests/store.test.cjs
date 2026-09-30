'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createLogger, createSettings } = require('../lib/store.cjs');

test('settings persist, dedupe recent files, and survive corruption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mve settings '));
  const settings = createSettings(dir);
  settings.addRecent('C:\\a.mmd');
  settings.addRecent('C:\\b.mmd');
  settings.addRecent('c:\\A.MMD');
  settings.set('lastDir', 'C:\\');
  const reloaded = createSettings(dir);
  assert.deepEqual(reloaded.recentFiles, ['c:\\A.MMD', 'C:\\b.mmd']);
  assert.equal(reloaded.get('lastDir'), 'C:\\');
  fs.writeFileSync(settings.file, '{broken');
  assert.deepEqual(createSettings(dir).recentFiles, []);
});

test('logger writes lines and rotates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mve log '));
  const log = createLogger(dir);
  log.info('hello');
  assert.match(fs.readFileSync(log.file, 'utf8'), /INFO hello/);
  fs.writeFileSync(log.file, 'x'.repeat(1024 * 1024 + 1));
  log.warn('after rotate');
  assert.ok(fs.existsSync(path.join(dir, 'app.old.log')));
  assert.match(fs.readFileSync(log.file, 'utf8'), /^.*WARN after rotate\n$/);
});
