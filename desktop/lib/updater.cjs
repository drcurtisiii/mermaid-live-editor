'use strict';
// File-based, side-by-side updates from a (Dropbox-synced) folder containing
// latest.json + versioned executables. Pure Node - no Electron - so it is
// unit-testable. SHA-256 detects corruption/partial sync; it is not a
// substitute for code signing.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'Mermaid View Edit';
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

class UpdateError extends Error {}
// Thrown when the release files look incomplete, typically Dropbox still syncing.
class NotReadyError extends UpdateError {}

const parseSemver = (version) => {
  const match = SEMVER_RE.exec(String(version ?? '').trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  };
};

/** Semantic-version comparison (including pre-release precedence). Returns -1, 0 or 1. */
const compareSemver = (a, b) => {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (!va || !vb) throw new UpdateError(`Invalid version: ${va ? b : a}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] > vb[key] ? 1 : -1;
  }
  const pa = va.prerelease;
  const pb = vb.prerelease;
  if (pa.length === 0 || pb.length === 0) {
    return pa.length === pb.length ? 0 : pa.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb && Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i]) ? 1 : -1;
    if (na !== nb) return na ? -1 : 1;
    if (!na && pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
};

const releaseFileName = (version) => `${APP_NAME} v${version}.exe`;

/** Validates a parsed latest.json object. Returns the manifest or throws UpdateError. */
const validateManifest = (manifest) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new UpdateError('Manifest is not a JSON object.');
  }
  const { app_name, version, filename, sha256, size } = manifest;
  if (app_name !== APP_NAME) throw new UpdateError(`Manifest is for "${app_name}", not ${APP_NAME}.`);
  if (!parseSemver(version)) throw new UpdateError(`Manifest version "${version}" is not valid.`);
  if (filename !== releaseFileName(version)) {
    throw new UpdateError(`Manifest filename must be "${releaseFileName(version)}".`);
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new UpdateError('Manifest sha256 is missing or malformed.');
  }
  if (!Number.isSafeInteger(size) || size <= 0) throw new UpdateError('Manifest size is invalid.');
  return { ...manifest, release_notes: String(manifest.release_notes ?? '') };
};

/** update_config.json beside the exe may point to another updates folder. */
const resolveUpdateDirectory = (appDir) => {
  const configPath = path.join(appDir, 'update_config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof config.update_directory === 'string' && config.update_directory.trim()) {
        return path.resolve(appDir, config.update_directory.trim());
      }
    } catch (error) {
      throw new UpdateError(`update_config.json could not be read: ${error.message}`);
    }
  }
  return path.join(appDir, 'updates');
};

const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });

/** Verifies size + SHA-256 of a file against the manifest. */
const verifyFile = async (filePath, manifest) => {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new NotReadyError(`${path.basename(filePath)} is not available yet.`);
  }
  if (stat.size !== manifest.size) {
    throw new NotReadyError(
      `${path.basename(filePath)} is ${stat.size} bytes, expected ${manifest.size} (still syncing?).`
    );
  }
  const digest = await sha256File(filePath);
  if (digest.toLowerCase() !== manifest.sha256.toLowerCase()) {
    throw new NotReadyError(`${path.basename(filePath)} checksum does not match (still syncing?).`);
  }
};

/**
 * Looks for a newer release. Returns undefined when there is none; throws
 * UpdateError/NotReadyError for problems (callers log and try again later).
 */
const checkForUpdate = async ({ appDir, currentVersion }) => {
  const updateDir = resolveUpdateDirectory(appDir);
  const manifestPath = path.join(updateDir, 'latest.json');
  if (!fs.existsSync(manifestPath)) return undefined;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new NotReadyError(`latest.json could not be parsed: ${error.message}`);
  }
  const manifest = validateManifest(raw);
  if (compareSemver(manifest.version, currentVersion) <= 0) return undefined;
  const source = path.join(updateDir, manifest.filename);
  await verifyFile(source, manifest);
  return { manifest, source, target: path.join(appDir, manifest.filename) };
};

/**
 * Copies the verified release beside the running exe: temp copy, verify,
 * rename. Never overwrites an existing version; reuses it only if its hash matches.
 * Returns the installed exe path.
 */
const installUpdate = async ({ manifest, source, target }) => {
  if (fs.existsSync(target)) {
    try {
      await verifyFile(target, manifest);
      return target;
    } catch {
      throw new UpdateError(
        `${path.basename(target)} already exists but does not match the release; it was left untouched.`
      );
    }
  }
  await verifyFile(source, manifest);
  const temp = `${target}.${process.pid}.download`;
  try {
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
    await verifyFile(temp, manifest);
    if (fs.existsSync(target)) throw new UpdateError(`${path.basename(target)} appeared during install.`);
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
};

module.exports = {
  APP_NAME,
  NotReadyError,
  UpdateError,
  checkForUpdate,
  compareSemver,
  installUpdate,
  parseSemver,
  releaseFileName,
  resolveUpdateDirectory,
  sha256File,
  validateManifest,
  verifyFile
};
