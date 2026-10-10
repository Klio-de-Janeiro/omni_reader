import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateFile, validateBytes, validateOffice } from '../dist/validation.js';
const buffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
for (const ext of ['pdf', 'docx', 'pptx', 'wav', 'ogg', 'jpg', 'png', 'xlsx', 'csv']) test(`accepts real ${ext} fixture`, async () => {
  const bytes = await readFile(new URL(`./fixtures/sample.${ext}`, import.meta.url));
  assert.equal(validateFile({ name: `sample.${ext.toUpperCase()}`, size: bytes.length }), ext);
  validateBytes(buffer(bytes), ext);
});
test('rejects empty, unknown and oversized files', () => {
  assert.throws(() => validateFile({ name: 'a.pdf', size: 0 }));
  assert.throws(() => validateFile({ name: 'a.exe', size: 30 }));
  assert.throws(() => validateFile({ name: 'a.docx', size: 500000000 }));
});
test('rejects spoofed extensions and malformed Office containers', () => {
  assert.throws(() => validateBytes(new TextEncoder().encode('not a PDF').buffer, 'pdf'));
  assert.throws(() => validateOffice(new ArrayBuffer(30), 'pptx'));
});
test('rejects an Office ZIP with a forged huge uncompressed entry', async () => {
  const bytes = await readFile(new URL('./fixtures/sample.docx', import.meta.url));
  const data = buffer(bytes); const view = new DataView(data);
  for (let pos = 0; pos + 46 < data.byteLength; pos++) if (view.getUint32(pos, true) === 0x02014b50) { view.setUint32(pos + 24, 200 * 1024 * 1024, true); break; }
  assert.throws(() => validateOffice(data, 'docx'), /распаковки/);
});
