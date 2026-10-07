import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const project = fileURLToPath(new URL('../', import.meta.url));
const desktopRequire = createRequire(path.join(project, 'desktop/package.json'));
const execute = promisify(execFile);
const markerName = '.omni-windows-tools.json';
export const WINDOWS_TOOLS = {
  version: '2.6.0',
  url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z',
  // Same SHA-512 as app-builder's DownloadWinCodeSign; verify before unpacking.
  checksum: '6LQI2d9BPC3Xs0ZoTQe1o3tPiA28c7+PY69Q9i/pD8lY45psMtHuLwv3vRckiVr3Zx1cbNyLlBR8STwCdcHwtA=='
};
const requiredFiles = ['rcedit-x64.exe', 'rcedit-ia32.exe', 'windows-10/x64/signtool.exe', 'windows-10/ia32/signtool.exe', 'windows-6/signtool.exe'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = value => typeof value === 'string' && value.length > 0 && !path.posix.isAbsolute(value) && !value.includes('\\') && !value.split('/').includes('..') && !value.includes(':');

async function inventory(root, relative = '') {
  const files = [];
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, item.name);
    if (item.isSymbolicLink()) throw new Error(`Unexpected symbolic link in Windows tools: ${name}`);
    if (item.isDirectory()) files.push(...await inventory(root, name));
    else if (item.isFile()) files.push({ file: name, sha256: digest(await readFile(path.join(root, name))) });
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

async function ready(root, source) {
  try {
    const marker = JSON.parse(await readFile(path.join(root, markerName), 'utf8'));
    if (marker.format !== 1 || marker.checksum !== source.checksum || !Array.isArray(marker.files) || marker.files.length > 500) return false;
    const names = new Set(marker.files.map(item => item.file));
    if (requiredFiles.some(file => !names.has(file))) return false;
    for (const item of marker.files) {
      if (!safePath(item.file) || digest(await readFile(path.join(root, item.file))) !== item.sha256) return false;
    }
    return true;
  } catch { return false; }
}

/** Prepare the cache expected by pinned electron-builder without macOS symlinks. */
export async function prepareWindowsTools({ cacheDir, source = WINDOWS_TOOLS, download, extract, log = console.log }) {
  const parent = path.join(cacheDir, 'winCodeSign'), target = path.join(parent, `winCodeSign-${source.version}`);
  if (await ready(target, source)) { log('Windows build tools are ready (cached).'); return target; }
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, 'omni-prepare-')), archive = path.join(temporary, 'tools.7z'), unpacked = path.join(temporary, 'unpacked');
  try {
    log('Preparing Windows build tools without symbolic links...');
    const fetchArchive = download || desktopRequire('app-builder-lib/out/binDownload.js').download;
    await fetchArchive(source.url, archive, source.checksum);
    if (createHash('sha512').update(await readFile(archive)).digest('base64') !== source.checksum) throw new Error('Windows tools checksum mismatch. The downloaded archive was not unpacked.');
    await mkdir(unpacked);
    // Pass arguments directly: spaces, Unicode and shell metacharacters stay in paths.
    const args = ['x', '-bd', '-y', archive, '-o' + unpacked, '-xr!darwin', '-xr!linux'];
    if (extract) await extract(args);
    else await execute(desktopRequire('7zip-bin').path7za, args, { windowsHide: true, shell: false });
    const files = await inventory(unpacked), names = new Set(files.map(item => item.file));
    if (requiredFiles.some(file => !names.has(file))) throw new Error('The Windows tools archive is incomplete: rcedit or signtool is missing.');
    if (files.some(item => /^(darwin|linux)\//.test(item.file))) throw new Error('Non-Windows tools were unexpectedly unpacked.');
    await writeFile(path.join(unpacked, markerName), JSON.stringify({ format: 1, checksum: source.checksum, files }));
    // Replace only this managed tool directory after checksum and extraction succeed.
    await rm(target, { recursive: true, force: true });
    await rename(unpacked, target);
    log('Windows build tools prepared; EXE icon and version editing remain enabled.');
    return target;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function builderInvocation({ args = [], env = process.env, cacheDir, cli = desktopRequire.resolve('electron-builder/out/cli/cli.js') }) {
  return { command: process.execPath, args: [cli, '--win', 'nsis', '--x64', ...args], options: { cwd: path.join(project, 'desktop'), env: { ...env, ELECTRON_BUILDER_CACHE: cacheDir }, stdio: 'inherit', shell: false, windowsHide: true } };
}

/** Build through the existing NSIS configuration using a separate local tool cache. */
export async function buildWindows(args = process.argv.slice(2)) {
  if (process.platform !== 'win32') throw new Error('Run BUILD_WINDOWS.cmd on Windows to build the Windows installer.');
  const version = desktopRequire('app-builder-lib/package.json').version;
  if (version !== '26.0.12') throw new Error(`Windows tool preparation expects electron-builder 26.0.12; installed ${version}. Restore desktop dependencies with npm ci.`);
  const cacheDir = path.join(project, '.tools', 'electron-builder-windows');
  await prepareWindowsTools({ cacheDir });
  const invocation = builderInvocation({ args, cacheDir });
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, invocation.options);
    child.once('error', reject);
    child.once('exit', (code, signal) => signal ? reject(new Error(`Windows build stopped: ${signal}`)) : resolve(code ?? 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await buildWindows(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
