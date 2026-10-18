import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { LatexService, parseDiagnostics, LIMITS } = createRequire(import.meta.url)('../desktop/latex.cjs');
const testRoot = fileURLToPath(new URL('../test-results/latex-service/', import.meta.url));
const source = mode => `% TEST_MODE=${mode || 'NORMAL'}\n\\documentclass{article}\n\\begin{document}\nПривет, LaTeX!\n\\end{document}\n`;

/** Run actual Node child processes in the same isolated working directories as Tectonic. */
async function fixture(t, options = {}) {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(path.join(testRoot, 'case-'));
  const runtime = path.join(directory, 'runtime'), compiler = path.join(runtime, process.platform === 'win32' ? 'tectonic.exe' : 'tectonic');
  await mkdir(runtime); await writeFile(compiler, '', { mode: 0o755 });
  const capture = path.join(directory, 'capture.json'), worker = path.join(directory, 'compiler-fixture.cjs');
  await writeFile(worker, `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2), input = args.at(-1), output = args[args.indexOf('--outdir') + 1];
    const source = fs.readFileSync(input, 'utf8'), stem = input.replace(/\\.tex$/i, '');
    const mode = source.match(/TEST_MODE=(\\w+)/)?.[1] || 'NORMAL';
    const pdf = path.join(output, stem + '.pdf'), log = path.join(output, stem + '.log');
    const details = { args, source, cwd: process.cwd(), cache: process.env.TECTONIC_CACHE_DIR, untrusted: process.env.TECTONIC_UNTRUSTED_MODE };
    if (mode === 'ASSETS') { details.chapter = fs.readFileSync('chapters/one.tex', 'utf8'); details.image = Array.from(fs.readFileSync('images/example.bin')); }
    fs.writeFileSync(process.env.OMNI_TEST_LATEX_CAPTURE, JSON.stringify(details));
    if (mode === 'NO_PDF') process.exit(0);
    fs.writeFileSync(pdf, '%PDF-1.7\\nfixture PDF\\n%%EOF\\n');
    if (mode === 'ERROR') { console.error('error: ' + input + ':7: Undefined control sequence'); fs.writeFileSync(log, '! LaTeX Error: Missing document.\\nl.12 \\\\bad\\n'); process.exit(1); }
    if (mode === 'WAIT' || mode === 'WAIT_TREE') {
      if (mode === 'WAIT_TREE') { details.descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }).pid; fs.writeFileSync(process.env.OMNI_TEST_LATEX_CAPTURE, JSON.stringify(details)); }
      console.log('READY'); setInterval(() => {}, 1000);
    }
    else if (mode === 'INVALID') fs.writeFileSync(pdf, 'this is not a PDF');
    else if (mode === 'BIG_PDF') fs.truncateSync(pdf, 50 * 1024 * 1024 + 1);
    else if (mode === 'BIG_LOG') { fs.writeFileSync(log, 'start'); fs.truncateSync(log, 5 * 1024 * 1024 + 1); }
    else if (mode === 'SPAM' || mode === 'SPAM_BAD') { process.stdout.write(Buffer.alloc(5 * 1024 * 1024 + 100, mode === 'SPAM_BAD' ? 255 : 65)); setInterval(() => {}, 1000); }
    else { console.log('note: Processing ' + input); fs.writeFileSync(log, 'LaTeX Warning: Label changed on input line 4.\\n'); }
  `);
  const starts = []; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const service = new LatexService({ runtimeDir: runtime, cacheDir: path.join(directory, 'cache'), compilerPath: compiler, ...options,
    spawn(command, args, settings) {
      if (path.basename(command).toLowerCase() === 'taskkill.exe') return spawn(command, args, settings);
      assert.equal(command, compiler);
      assert.equal(settings.shell, false); assert.equal(settings.windowsHide, true);
      assert.deepEqual(args.slice(0, 3), ['--untrusted', '--keep-logs', '--outdir']);
      assert.equal(settings.env.TECTONIC_UNTRUSTED_MODE, '1');
      assert.equal(path.isAbsolute(settings.env.TECTONIC_CACHE_DIR), true);
      starts.push({ command, args, settings });
      const child = spawn(process.execPath, [worker, ...args], { ...settings, env: { ...settings.env, OMNI_TEST_LATEX_CAPTURE: capture } });
      child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) started(child); });
      return child;
    }
  });
  t.after(async () => {
    service.dispose();
    if (path.dirname(directory) !== path.resolve(testRoot)) throw new Error('Unsafe test cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  return { service, directory, capture, starts, ready };
}

async function cleanJobs(service) { assert.deepEqual(await readdir(service.jobsDir), []); assert.equal(service.job, null); }

test('Tectonic service compiles UTF-8 snapshots and nested assets with fixed safe arguments', async t => {
  const { service, capture, starts } = await fixture(t);
  assert.deepEqual(await service.status(), { available: true, engine: 'Tectonic', message: 'Tectonic готов к компиляции.' });
  const input = source('ASSETS');
  const result = await service.compile({ id: 'draft-1', name: 'Пример & текст.tex', source: input, files: [{ path: 'chapters/one.tex', bytes: 'Глава ✓' }, { path: 'images/example.bin', bytes: new Uint8Array([0, 255, 4]) }] });
  assert.equal(result.ok, true); assert.equal(result.engine, 'Tectonic'); assert.ok(result.pdf instanceof Uint8Array);
  assert.match(Buffer.from(result.pdf).toString(), /^%PDF-/); assert.match(result.log, /Processing/);
  assert.deepEqual(result.diagnostics, [{ line: 4, message: 'Label changed on input line 4.', severity: 'warning' }]);
  const details = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(details.source, input); assert.equal(details.chapter, 'Глава ✓'); assert.deepEqual(details.image, [0, 255, 4]);
  assert.equal(details.args.at(-1), 'Пример & текст.tex'); assert.equal(details.untrusted, '1');
  assert.ok(details.cwd.startsWith(service.jobsDir + path.sep));
  assert.equal(starts.length, 1); await cleanJobs(service);
});

test('Failed LaTeX compilation returns located diagnostics and never a PDF emitted before the error', async t => {
  const { service } = await fixture(t);
  const result = await service.compile({ name: 'main.tex', source: source('ERROR') });
  assert.equal(result.ok, false); assert.equal(result.pdf, null);
  assert.deepEqual(result.diagnostics, [{ line: 7, message: 'Undefined control sequence', severity: 'error' }, { line: 12, message: 'LaTeX Error: Missing document.', severity: 'error' }]);
  assert.match(result.log, /код 1/); await cleanJobs(service);
});

test('Successive builds use fresh directories and cannot reuse an earlier PDF', async t => {
  const { service, starts } = await fixture(t);
  assert.equal((await service.compile({ name: 'main.tex', source: source() })).ok, true);
  const missing = await service.compile({ name: 'main.tex', source: source('NO_PDF') });
  assert.equal(missing.ok, false); assert.equal(missing.pdf, null); assert.match(missing.log, /без PDF/);
  assert.notEqual(starts[0].settings.cwd, starts[1].settings.cwd); await cleanJobs(service);
});

test('Tectonic validates PDF signature and size before returning bytes', async t => {
  const { service } = await fixture(t);
  for (const mode of ['INVALID', 'BIG_PDF']) {
    const result = await service.compile({ name: 'main.tex', source: source(mode) });
    assert.equal(result.ok, false); assert.equal(result.pdf, null); assert.match(result.log, /PDF|50 МиБ/); await cleanJobs(service);
  }
});

test('A real compiler timeout stops the job and discards any partial PDF', { timeout: 10000 }, async t => {
  const { service } = await fixture(t, { timeoutMs: 250 });
  const result = await service.compile({ name: 'main.tex', source: source('WAIT') });
  assert.equal(result.ok, false); assert.equal(result.pdf, null); assert.match(result.log, /Время компиляции/); await cleanJobs(service);
});

test('Abort cancels a real process, rejects concurrent builds and releases the service', { timeout: 10000 }, async t => {
  const { service, ready } = await fixture(t), controller = new AbortController();
  const running = service.compile({ name: 'main.tex', source: source('WAIT') }, { signal: controller.signal });
  const child = await ready;
  await assert.rejects(service.compile({ name: 'other.tex', source: source() }), /уже выполняется/);
  const cancelled = assert.rejects(running, error => error.name === 'AbortError'); controller.abort(); await cancelled;
  assert.notEqual(child.exitCode, 0); await cleanJobs(service);
  assert.equal((await service.compile({ name: 'main.tex', source: source() })).ok, true); await cleanJobs(service);
});

test('Dispose cancels the current process and prevents subsequent builds', { timeout: 10000 }, async t => {
  const { service, ready } = await fixture(t);
  const running = service.compile({ name: 'main.tex', source: source('WAIT') });
  await ready;
  const cancelled = assert.rejects(running, error => error.name === 'AbortError'); service.dispose(); await cancelled;
  await assert.rejects(service.compile({ name: 'main.tex', source: source() }), /закрыт/); await cleanJobs(service);
});

test('Cancellation terminates descendants rather than leaving compiler child processes behind', { timeout: 10000 }, async t => {
  const { service, ready, capture } = await fixture(t), controller = new AbortController();
  const running = service.compile({ name: 'main.tex', source: source('WAIT_TREE') }, { signal: controller.signal });
  await ready;
  const { descendant } = JSON.parse(await readFile(capture, 'utf8'));
  t.after(() => { try { process.kill(descendant, 'SIGKILL'); } catch {} });
  const cancelled = assert.rejects(running, error => error.name === 'AbortError'); controller.abort(); await cancelled;
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try { process.kill(descendant, 0); await new Promise(resolve => setTimeout(resolve, 50)); }
    catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
  }
  assert.equal(alive, false); await cleanJobs(service);
});

test('Both subprocess output and TeX log files stay below the log limit', { timeout: 10000 }, async t => {
  const { service } = await fixture(t);
  for (const mode of ['BIG_LOG', 'SPAM', 'SPAM_BAD']) {
    const result = await service.compile({ name: 'main.tex', source: source(mode) });
    assert.equal(result.ok, false); assert.equal(result.pdf, null); assert.match(result.log, /5 МиБ/);
    assert.ok(Buffer.byteLength(result.log, 'utf8') <= LIMITS.log); await cleanJobs(service);
  }
});

test('Compiler launch errors are returned as diagnostics and clean up the temporary job', async t => {
  const { service } = await fixture(t);
  service.spawn = () => { throw new Error('fixture launch failed'); };
  const result = await service.compile({ name: 'main.tex', source: source() });
  assert.equal(result.ok, false); assert.equal(result.pdf, null); assert.match(result.log, /fixture launch failed/);
  assert.equal(result.diagnostics[0].severity, 'error'); await cleanJobs(service);
});

test('Input validation rejects traversal, links, output collisions, overlapping paths and oversized snapshots', async t => {
  const { service, starts } = await fixture(t);
  const invalidFiles = ['../outside.tex', '/outside.tex', 'C:/outside.tex', 'a/../../outside.tex', 'a\\outside.tex', 'a//b.tex', 'output/main.pdf', 'MAIN.PDF', 'main.tex', 'NUL.tex'];
  for (const relative of invalidFiles) await assert.rejects(service.compile({ name: 'main.tex', source: source(), files: [{ path: relative, bytes: 'x' }] }));
  for (const name of ['../main.tex', 'C:\\main.tex', 'NUL.tex', 'main.txt']) await assert.rejects(service.compile({ name, source: source() }));
  await assert.rejects(service.compile({ name: 'main.tex', source: source(), files: [{ path: 'file.tex', bytes: 'x', symlink: '/outside' }] }), /ссылки/);
  await assert.rejects(service.compile({ name: 'main.tex', source: source(), files: [{ path: 'chapters', bytes: 'x' }, { path: 'chapters/one.tex', bytes: 'y' }] }), /пересекаются/);
  await assert.rejects(service.compile({ name: 'main.tex', source: 'x'.repeat(LIMITS.source + 1) }), /8 МиБ/);
  await assert.rejects(service.compile({ name: 'main.tex', source: source(), files: Array.from({ length: 257 }, (_, i) => ({ path: `${i}.tex`, bytes: '' })) }), /256/);
  await assert.rejects(service.compile({ name: 'main.tex', source: source(), files: [{ path: 'large.bin', bytes: new Uint8Array(LIMITS.assets + 1) }] }), /64 МиБ/);
  assert.equal(starts.length, 0); assert.equal(service.job, null);
});

test('Unavailable runtime leaves a useful diagnostic and aborted jobs do not start a compiler', async t => {
  const { service, starts } = await fixture(t);
  service.findCompiler = async () => null;
  const status = await service.status(); assert.equal(status.available, false); assert.equal(status.engine, 'Tectonic');
  const missing = await service.compile({ name: 'main.tex', source: source() });
  assert.equal(missing.ok, false); assert.equal(missing.pdf, null); assert.match(missing.log, /не найден/);
  await assert.rejects(service.compile({ name: 'main.tex', source: source() }, { signal: AbortSignal.abort() }), error => error.name === 'AbortError');
  assert.equal(starts.length, 0); assert.equal(service.job, null);
});

test('Diagnostic parser handles Windows paths, standard TeX errors and warnings without injecting markup', () => {
  const log = '\u001b[31merror: C:\\tex projects\\main.tex:18: Undefined control sequence\u001b[0m\n! <script>bad</script>\nl.21 \\bad\nwarning: main.tex:3: Reference is undefined\nOverfull \\hbox (1pt too wide) in paragraph at lines 8--9\n';
  assert.deepEqual(parseDiagnostics(log), [
    { line: 18, message: 'Undefined control sequence', severity: 'error' },
    { line: 21, message: '<script>bad</script>', severity: 'error' },
    { line: 3, message: 'Reference is undefined', severity: 'warning' },
    { line: 8, message: 'Overfull \\hbox (1pt too wide) in paragraph at lines 8--9', severity: 'warning' }
  ]);
});
