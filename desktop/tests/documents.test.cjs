'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const docs = require('../lib/documents.cjs');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mve docs ü (it's) "));

test('filesFromArgv drops switches and resolves relative paths', () => {
  const files = docs.filesFromArgv(
    ['app.exe', '--mve-wait-pid=12', 'a b.mmd', 'C:\\x\\ü.md', '', '--inspect'],
    { cwd: 'C:\\work' }
  );
  assert.deepEqual(files, ['C:\\work\\a b.mmd', 'C:\\x\\ü.md']);
});

test('validatePaths accepts supported files and reports the rest', () => {
  const dir = tempDir();
  const good = path.join(dir, 'flow chart.mmd');
  const alsoGood = path.join(dir, 'notes.MD');
  const bad = path.join(dir, 'letter.docx');
  fs.writeFileSync(good, 'flowchart LR\n A-->B');
  fs.writeFileSync(alsoGood, '```mermaid\ngraph TD\nA-->B\n```');
  fs.writeFileSync(bad, 'x');
  const result = docs.validatePaths([good, alsoGood, bad, path.join(dir, 'nope.mmd'), dir, good]);
  assert.deepEqual(result.valid, [good, alsoGood]);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0].error, /Unsupported/);
  assert.match(result.errors[1].error, /not found/);
  assert.match(result.errors[2].error, /Not a file/);
});

test('validatePaths rejects oversized files', () => {
  const dir = tempDir();
  const big = path.join(dir, 'big.mmd');
  fs.writeFileSync(big, Buffer.alloc(docs.MAX_FILE_BYTES + 1, 97));
  assert.match(docs.validatePaths([big]).errors[0].error, /larger than 5 MB/);
});

test('mermaid file round-trips, preserving BOM and CRLF', () => {
  const dir = tempDir();
  const file = path.join(dir, 'crlf.mermaid');
  fs.writeFileSync(file, '\uFEFFgraph TD\r\n  A-->B\r\n');
  const doc = docs.readDocument(file);
  assert.equal(doc.code, 'graph TD\n  A-->B\n');
  docs.writeDocument(doc, 'graph TD\n  A-->C\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '\uFEFFgraph TD\r\n  A-->C\r\n');
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    [],
    'no temp files left behind'
  );
});

test('markdown: edits only the chosen mermaid block and keeps the rest', () => {
  const dir = tempDir();
  const file = path.join(dir, 'memo.md');
  const original = [
    '# Memo',
    '',
    '```mermaid',
    'graph TD',
    'A-->B',
    '```',
    '',
    'Middle text',
    '',
    '~~~~mermaid',
    'sequenceDiagram',
    'A->>B: hi',
    '~~~~',
    'End'
  ].join('\n');
  fs.writeFileSync(file, original);
  assert.equal(docs.findMermaidBlocks(original).length, 2);
  const doc = docs.readDocument(file, { blockIndex: 1 });
  assert.equal(doc.kind, 'markdown');
  assert.equal(doc.code, 'sequenceDiagram\nA->>B: hi');
  // Someone edits the prose while the diagram is open; the save keeps it.
  fs.writeFileSync(file, original.replace('Middle text', 'Edited middle'));
  docs.writeDocument(doc, 'sequenceDiagram\nA->>B: bye');
  const saved = fs.readFileSync(file, 'utf8');
  assert.match(saved, /Edited middle/);
  assert.match(saved, /A->>B: bye\n~~~~\nEnd$/);
  assert.match(saved, /```mermaid\ngraph TD\nA-->B\n```/);
});

test('markdown without a mermaid block is a controlled error', () => {
  const dir = tempDir();
  const file = path.join(dir, 'plain.md');
  fs.writeFileSync(file, '# nothing here\n```js\nx\n```');
  assert.throws(() => docs.readDocument(file), docs.DocumentError);
});

test('saving into markdown whose block disappeared fails without writing', () => {
  const dir = tempDir();
  const file = path.join(dir, 'gone.md');
  fs.writeFileSync(file, '```mermaid\ngraph TD\n```\n');
  const doc = docs.readDocument(file);
  fs.writeFileSync(file, 'block removed');
  assert.throws(() => docs.writeDocument(doc, 'graph LR'), docs.DocumentError);
  assert.equal(fs.readFileSync(file, 'utf8'), 'block removed');
});
