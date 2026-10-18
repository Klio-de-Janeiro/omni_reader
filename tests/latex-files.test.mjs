import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { saveLatexFile, saveLatexDestination, collectLatexFiles } from '../desktop/latex-files.cjs';

async function project(t) {
  await mkdir('.tools', { recursive: true });
  const root = await mkdtemp(path.resolve('.tools/latex-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('TeX saves atomically at the same path and external changes are preserved', async t => {
  const root = await project(t), file = path.join(root, 'main.tex');
  await writeFile(file, 'before');
  await saveLatexFile(file, Buffer.from('Привет\r\n'), Buffer.from('before'));
  assert.equal(await readFile(file, 'utf8'), 'Привет\r\n');
  await assert.rejects(saveLatexFile(file, Buffer.from('lost'), Buffer.from('before')), /изменён/);
  assert.equal(await readFile(file, 'utf8'), 'Привет\r\n');
  assert.deepEqual(await readdir(root), ['main.tex']);
  await saveLatexFile(file, Buffer.alloc(0), Buffer.from('Привет\r\n'));
  assert.equal((await readFile(file)).length, 0);
});
test('Companions follow relative includes and graphics without copying unrelated files', async t => {
  const root = await project(t), main = path.join(root, 'main.tex');
  await mkdir(path.join(root, 'sections')); await mkdir(path.join(root, 'images'));
  await writeFile(main, 'old source');
  await writeFile(path.join(root, 'sections/chapter.tex'), '\\input{other}');
  await writeFile(path.join(root, 'other.tex'), 'text');
  await writeFile(path.join(root, 'images/figure.png'), new Uint8Array([1,2,3]));
  await writeFile(path.join(root, 'references.bib'), '@book{x}');
  await writeFile(path.join(root, 'private.env'), 'secret');
  const files = await collectLatexFiles(main, '\\input{sections/chapter}\n\\graphicspath{{images/}}\\includegraphics{figure}\\bibliography{references}\n% \\input{private.env}');
  assert.deepEqual(files.map(file => file.path), ['sections/chapter.tex', 'other.tex', 'images/figure.png', 'references.bib']);
  assert.equal(files[1].bytes.toString(), 'text');
});
test('Save As creates a complete source, replaces only a selected file and cleans staging files', async t => {
  const root = await project(t), file = path.join(root,'chosen.tex');
  await saveLatexDestination(file,Buffer.from('first'));
  assert.equal(await readFile(file,'utf8'),'first');
  await saveLatexDestination(file,Buffer.from('second'));
  assert.equal(await readFile(file,'utf8'),'second');
  await assert.rejects(saveLatexDestination(path.join(root,'blocked.tex'),'x'.repeat(8*1024*1024+1)),/8 МиБ/);
  assert.deepEqual(await readdir(root),['chosen.tex']);
});
test('A failed atomic commit leaves the existing TeX source intact', async t => {
  const root = await project(t), file = path.join(root,'chosen.tex');
  await writeFile(file,'keep the original');
  const fs = createRequire(import.meta.url)('node:fs/promises');
  t.mock.method(fs,'rename',async () => { throw Object.assign(new Error('disk full'),{code:'ENOSPC'}); });
  await assert.rejects(saveLatexDestination(file,Buffer.from('new source')), /disk full/);
  assert.equal(await readFile(file,'utf8'),'keep the original');
  assert.deepEqual(await readdir(root),['chosen.tex']);
});
test('Companion discovery ignores traversal and absolute references', async t => {
  const root = await project(t), main = path.join(root, 'main.tex');
  await writeFile(main, '');
  assert.deepEqual(await collectLatexFiles(main, '\\input{../secret}\\input{/absolute/secret}\\input{C:/private}'), []);
});
test('Windows packaging includes the LaTeX backend and a compiler outside ASAR', async () => {
  const { build } = JSON.parse(await readFile('desktop/package.json','utf8'));
  assert.ok(build.files.includes('latex.cjs')); assert.ok(build.files.includes('latex-files.cjs'));
  const runtime = build.extraResources.find(item=>item.from==='latex-runtime');
  assert.equal(runtime.to,'latex-runtime');
  assert.ok(runtime.filter.includes('tectonic.exe')); assert.ok(runtime.filter.includes('TECTONIC-LICENSE.txt'));
});
