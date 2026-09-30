'use strict';
// File handling for Mermaid View Edit: which files are accepted, how Mermaid
// source is pulled out of (and written back into) them, and how command-line
// arguments become file paths. Pure Node - no Electron - so it is unit-testable.

const fs = require('node:fs');
const path = require('node:path');

const MERMAID_EXTENSIONS = ['.mmd', '.mermaid', '.txt'];
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];
const SUPPORTED_EXTENSIONS = [...MERMAID_EXTENSIONS, ...MARKDOWN_EXTENSIONS];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const BOM = '﻿';

// ```mermaid / ~~~mermaid fenced blocks. Group 1 = opening fence line,
// group 3 = body, group 4 = closing fence. Closing fence must use the same
// fence characters and be at least as long.
const FENCE_RE = /^([ \t]{0,3}(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\n)([\s\S]*?)(^[ \t]{0,3}\2[`~]*[ \t]*$)/gm;

class DocumentError extends Error {}

const isSupportedPath = (filePath) =>
  SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase());

const isMarkdownPath = (filePath) =>
  MARKDOWN_EXTENSIONS.includes(path.extname(filePath).toLowerCase());

/**
 * Turns process argv into candidate file paths. Chromium/Electron switches
 * (anything starting with "-") are dropped; relative paths are resolved
 * against the launch directory. Nothing here is ever executed or passed to a shell.
 */
const filesFromArgv = (argv, { cwd = process.cwd(), skip = 1 } = {}) =>
  argv
    .slice(skip)
    .filter((arg) => typeof arg === 'string' && arg.trim() !== '' && !arg.startsWith('-'))
    .map((arg) => path.resolve(cwd, arg));

/** Splits paths into openable files and per-file errors. Never throws. */
const validatePaths = (paths) => {
  const valid = [];
  const errors = [];
  const seen = new Set();
  for (const filePath of paths) {
    const key = filePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      errors.push({ file: filePath, error: 'File not found.' });
      continue;
    }
    if (!stat.isFile()) {
      errors.push({ file: filePath, error: 'Not a file.' });
    } else if (!isSupportedPath(filePath)) {
      errors.push({
        file: filePath,
        error: `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`
      });
    } else if (stat.size > MAX_FILE_BYTES) {
      errors.push({ file: filePath, error: 'File is larger than 5 MB.' });
    } else {
      valid.push(filePath);
    }
  }
  return { errors, valid };
};

/** Finds the mermaid fenced blocks in markdown text. */
const findMermaidBlocks = (text) => {
  const blocks = [];
  for (const match of text.matchAll(FENCE_RE)) {
    const bodyStart = match.index + match[1].length;
    blocks.push({
      bodyEnd: bodyStart + match[3].length,
      bodyStart,
      code: match[3].replace(/\n$/, '')
    });
  }
  return blocks;
};

const decode = (buffer) => {
  let text = buffer.toString('utf8');
  const hasBom = text.startsWith(BOM);
  if (hasBom) text = text.slice(1);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { eol, hasBom, text: text.replaceAll('\r\n', '\n') };
};

const encode = (text, { eol, hasBom }) => {
  const body = eol === '\r\n' ? text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n') : text;
  return (hasBom ? BOM : '') + body;
};

/**
 * Reads a document. For markdown, `blockIndex` selects which mermaid block is
 * edited (default: the first). Returns everything needed to save it back.
 */
const readDocument = (filePath, { blockIndex = 0 } = {}) => {
  const { valid, errors } = validatePaths([filePath]);
  if (valid.length === 0) throw new DocumentError(errors[0].error);
  const decoded = decode(fs.readFileSync(filePath));
  const doc = {
    blockCount: 1,
    blockIndex: 0,
    code: decoded.text,
    eol: decoded.eol,
    hasBom: decoded.hasBom,
    kind: 'mermaid',
    path: filePath
  };
  if (isMarkdownPath(filePath)) {
    const blocks = findMermaidBlocks(decoded.text);
    if (blocks.length === 0) {
      throw new DocumentError('No ```mermaid code block was found in this Markdown file.');
    }
    if (blockIndex < 0 || blockIndex >= blocks.length) {
      throw new DocumentError(`Mermaid block ${blockIndex + 1} does not exist.`);
    }
    Object.assign(doc, {
      blockCount: blocks.length,
      blockIndex,
      code: blocks[blockIndex].code,
      kind: 'markdown'
    });
  }
  return doc;
};

/** Returns the file text that results from saving `code` into `doc`. */
const renderForSave = (doc, code, currentFileText) => {
  const normalized = code.replaceAll('\r\n', '\n');
  if (doc.kind !== 'markdown') return encode(normalized, doc);
  // Re-read the markdown so edits made elsewhere in the file are kept.
  const { text } = decode(Buffer.from(currentFileText ?? '', 'utf8'));
  const blocks = findMermaidBlocks(text);
  const block = blocks[doc.blockIndex];
  if (!block) {
    throw new DocumentError(
      'The Markdown file no longer contains that mermaid block. Use Save As to save a copy.'
    );
  }
  const body = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  return encode(text.slice(0, block.bodyStart) + body + text.slice(block.bodyEnd), doc);
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Dropbox/antivirus can hold a brief lock on a file; retry the rename a few times.
const renameWithRetry = (from, to, attempts = 5) => {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      sleep(200 * attempt);
    }
  }
};

/**
 * Writes atomically: temp file in the same folder, then rename over the
 * target, so a crash or Dropbox sync never sees a half-written file.
 * Returns the saved file's modification time.
 */
const writeDocument = (doc, code) => {
  const current = doc.kind === 'markdown' ? fs.readFileSync(doc.path, 'utf8') : undefined;
  const output = renderForSave(doc, code, current);
  const temp = path.join(
    path.dirname(doc.path),
    `.${path.basename(doc.path)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(temp, output, 'utf8');
    renameWithRetry(temp, doc.path);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return fs.statSync(doc.path).mtimeMs;
};

module.exports = {
  DocumentError,
  MAX_FILE_BYTES,
  SUPPORTED_EXTENSIONS,
  decode,
  filesFromArgv,
  findMermaidBlocks,
  isMarkdownPath,
  isSupportedPath,
  readDocument,
  renderForSave,
  validatePaths,
  writeDocument
};
