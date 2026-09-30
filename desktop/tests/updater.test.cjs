'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const up = require('../lib/updater.cjs');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mve update '));

const publish = (dir, version, body = `exe ${version}`) => {
  const filename = up.releaseFileName(version);
  const updates = path.join(dir, 'updates');
  fs.mkdirSync(updates, { recursive: true });
  fs.writeFileSync(path.join(updates, filename), body);
  const manifest = {
    app_name: up.APP_NAME,
    filename,
    release_notes: 'notes',
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    size: Buffer.byteLength(body),
    version
  };
  fs.writeFileSync(path.join(updates, 'latest.json'), JSON.stringify(manifest));
  return manifest;
};

test('compareSemver follows semantic-version precedence', () => {
  assert.equal(up.compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(up.compareSemver('1.0.10', '1.0.9'), 1);
  assert.equal(up.compareSemver('1.2.0', '1.10.0'), -1);
  assert.equal(up.compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(up.compareSemver('1.0.0-beta', '1.0.0'), -1);
  assert.equal(up.compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(up.compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.throws(() => up.compareSemver('1.0', '1.0.0'), up.UpdateError);
});

test('validateManifest rejects malformed manifests', () => {
  const good = {
    app_name: up.APP_NAME,
    filename: 'Mermaid View Edit v1.2.3.exe',
    sha256: 'a'.repeat(64),
    size: 10,
    version: '1.2.3'
  };
  assert.equal(up.validateManifest(good).release_notes, '');
  for (const bad of [
    null,
    [],
    { ...good, app_name: 'Other' },
    { ...good, version: 'v1' },
    { ...good, filename: '..\\evil.exe' },
    { ...good, sha256: 'xyz' },
    { ...good, size: -1 }
  ]) {
    assert.throws(() => up.validateManifest(bad), up.UpdateError);
  }
});

test('no manifest, same version or older version means no update', async () => {
  const dir = tempDir();
  assert.equal(await up.checkForUpdate({ appDir: dir, currentVersion: '1.0.0' }), undefined);
  publish(dir, '1.0.0');
  assert.equal(await up.checkForUpdate({ appDir: dir, currentVersion: '1.0.0' }), undefined);
  assert.equal(await up.checkForUpdate({ appDir: dir, currentVersion: '1.1.0' }), undefined);
});

test('malformed or partially synced manifest raises a retryable error', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'updates'));
  fs.writeFileSync(path.join(dir, 'updates', 'latest.json'), '{"app_name": "Mermaid');
  await assert.rejects(up.checkForUpdate({ appDir: dir, currentVersion: '1.0.0' }), up.NotReadyError);
});

test('executable that is still syncing is not offered', async () => {
  const dir = tempDir();
  const manifest = publish(dir, '1.1.0');
  fs.writeFileSync(path.join(dir, 'updates', manifest.filename), 'partial');
  await assert.rejects(up.checkForUpdate({ appDir: dir, currentVersion: '1.0.0' }), up.NotReadyError);
  fs.rmSync(path.join(dir, 'updates', manifest.filename));
  await assert.rejects(up.checkForUpdate({ appDir: dir, currentVersion: '1.0.0' }), up.NotReadyError);
});

test('update_config.json redirects the updates folder', async () => {
  const appDir = tempDir();
  const shared = tempDir();
  publish(shared, '1.2.0');
  fs.writeFileSync(
    path.join(appDir, 'update_config.json'),
    JSON.stringify({ update_directory: path.join(shared, 'updates') })
  );
  const info = await up.checkForUpdate({ appDir, currentVersion: '1.0.0' });
  assert.equal(info.manifest.version, '1.2.0');
  fs.writeFileSync(path.join(appDir, 'update_config.json'), 'not json');
  assert.throws(() => up.resolveUpdateDirectory(appDir), up.UpdateError);
});

test('installUpdate copies side by side, verifies, and never overwrites', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, up.releaseFileName('1.0.0')), 'old exe');
  publish(dir, '1.1.0');
  const info = await up.checkForUpdate({ appDir: dir, currentVersion: '1.0.0' });
  const installed = await up.installUpdate(info);
  assert.equal(installed, path.join(dir, 'Mermaid View Edit v1.1.0.exe'));
  assert.equal(fs.readFileSync(installed, 'utf8'), 'exe 1.1.0');
  assert.equal(fs.readFileSync(path.join(dir, up.releaseFileName('1.0.0')), 'utf8'), 'old exe');
  // Re-running reuses the matching file.
  assert.equal(await up.installUpdate(info), installed);
  // A same-named file with different contents is left alone.
  fs.writeFileSync(installed, 'tampered');
  await assert.rejects(up.installUpdate(info), up.UpdateError);
  assert.equal(fs.readFileSync(installed, 'utf8'), 'tampered');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.download')), []);
});
