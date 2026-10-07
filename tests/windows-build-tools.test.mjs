import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { builderInvocation, prepareWindowsTools } from '../scripts/build-windows.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const desktopRequire = createRequire(path.join(project, 'desktop/package.json'));
const execute = promisify(execFile);
const sevenZip = desktopRequire('7zip-bin').path7za;
const silent = () => {};
let workspace, archive, source;

before(async () => {
  await mkdir(path.join(project, '.tools'), { recursive: true });
  workspace = await mkdtemp(path.join(project, '.tools', 'windows-tools-test-'));
  const input = path.join(workspace, 'input');
  for (const name of ['rcedit-x64.exe', 'rcedit-ia32.exe', 'windows-10/x64/signtool.exe', 'windows-10/ia32/signtool.exe', 'windows-6/signtool.exe', 'windows-10/x64/wintrust.dll', 'darwin/10.12/lib/libcrypto.1.dylib', 'linux/tool']) {
    await mkdir(path.dirname(path.join(input, name)), { recursive: true });
    await writeFile(path.join(input, name), 'fixture: ' + name);
  }
  if (process.platform !== 'win32') await symlink('libcrypto.1.dylib', path.join(input, 'darwin/10.12/lib/libcrypto.dylib'));
  else await writeFile(path.join(input, 'darwin/10.12/lib/libcrypto.dylib'), 'macOS fixture');
  archive = path.join(workspace, 'fixture.7z');
  await execute(sevenZip, ['a', '-t7z', '-snl', archive, '.'], { cwd: input, shell: false, windowsHide: true });
  source = { version: '2.6.0', url: 'fixture', checksum: createHash('sha512').update(await readFile(archive)).digest('base64') };
});
after(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });

const download = (_url, target) => copyFile(archive, target);
const prepare = cacheDir => prepareWindowsTools({ cacheDir, source, download, log: silent });

test('Real 7-Zip excludes macOS links, preserves Windows tools and feeds the pinned builder cache', async () => {
  const cacheDir = path.join(workspace, 'Папка с пробелами & tools');
  const target = await prepare(cacheDir);
  const entries = await readdir(target);
  assert.ok(!entries.includes('darwin') && !entries.includes('linux'));
  assert.equal(await readFile(path.join(target, 'windows-10/x64/wintrust.dll'), 'utf8'), 'fixture: windows-10/x64/wintrust.dll');
  assert.equal(await prepareWindowsTools({ cacheDir, source, download() { throw new Error('Valid cache must not download again'); }, log: silent }), target);
  // Invoke the actual app-builder cache lookup in a fresh process: it must not download.
  const code = `const desktopRequire = require('node:module').createRequire(${JSON.stringify(path.join(project, 'desktop/package.json'))}); desktopRequire('app-builder-lib/out/codeSign/windowsSignToolManager.js').getSignVendorPath().then(value => process.stdout.write(value)).catch(error => { console.error(error); process.exitCode = 1; });`;
  const result = await execute(process.execPath, ['-e', code], {
    cwd: project, env: { ...process.env, ELECTRON_BUILDER_CACHE: cacheDir }, shell: false
  });
  assert.equal(result.stdout, target);
});

test('A partially extracted or corrupted cache is rebuilt before packaging', async () => {
  const cacheDir = path.join(workspace, 'repair');
  const target = path.join(cacheDir, 'winCodeSign/winCodeSign-2.6.0');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'rcedit-x64.exe'), 'incomplete');
  await prepare(cacheDir);
  await writeFile(path.join(target, 'rcedit-x64.exe'), 'corrupted');
  let downloads = 0;
  await prepareWindowsTools({ cacheDir, source, log: silent, download(...args) { downloads++; return download(...args); } });
  assert.equal(downloads, 1);
  assert.equal(await readFile(path.join(target, 'rcedit-x64.exe'), 'utf8'), 'fixture: rcedit-x64.exe');
});

test('Checksum and extraction failures leave the previous directory intact and remove staging files', async () => {
  const cacheDir = path.join(workspace, 'failure'), parent = path.join(cacheDir, 'winCodeSign');
  const target = path.join(parent, 'winCodeSign-2.6.0');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'keep.txt'), 'previous');
  let extracted = false;
  await assert.rejects(prepareWindowsTools({ cacheDir, source, log: silent,
    download: (_url, output) => writeFile(output, 'wrong archive'),
    extract() { extracted = true; }
  }), /checksum mismatch/);
  assert.equal(extracted, false);
  await assert.rejects(prepareWindowsTools({ cacheDir, source, download, log: silent, extract() { throw new Error('Extraction failed'); } }), /Extraction failed/);
  assert.equal(await readFile(path.join(target, 'keep.txt'), 'utf8'), 'previous');
  assert.deepEqual(await readdir(parent), ['winCodeSign-2.6.0']);
});

test('The build launcher passes arguments without a shell and retains EXE resource editing', async () => {
  const cacheDir = path.join(workspace, 'cache & Unicode Я'), args = ['--publish', 'never', '--config.extraMetadata.note=A & B'];
  const invocation = builderInvocation({ args, cacheDir, env: { OMNI_TEST: 'yes' } });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args.slice(1), ['--win', 'nsis', '--x64', ...args]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.ELECTRON_BUILDER_CACHE, cacheDir);
  assert.equal(invocation.options.env.OMNI_TEST, 'yes');
  const config = JSON.parse(await readFile(path.join(project, 'desktop/package.json'), 'utf8'));
  assert.equal(config.build.win.signAndEditExecutable, true);
  assert.equal(config.build.win.icon, '../dist/icon.ico');
  assert.equal(config.scripts['dist:win'], 'node ../scripts/build-windows.mjs');
});
