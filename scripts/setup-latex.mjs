import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const project = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const maximumArchiveBytes = 64 * 1024 * 1024;
const release = 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Digests published by the upstream 0.17.0 release. Check before extraction.
// https://github.com/tectonic-typesetting/tectonic/releases/expanded_assets/tectonic%400.17.0
export const TECTONIC_VERSION = '0.17.0';
export const TECTONIC_DOWNLOADS = Object.freeze({
  'win32-x64': Object.freeze({ file: 'tectonic-0.17.0-x86_64-pc-windows-msvc.zip', sha256: 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f', entry: 'tectonic.exe' }),
  'linux-x64': Object.freeze({ file: 'tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz', sha256: '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7', entry: 'tectonic' }),
  'darwin-arm64': Object.freeze({ file: 'tectonic-0.17.0-aarch64-apple-darwin.tar.gz', sha256: 'a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667', entry: 'tectonic' }),
  'darwin-x64': Object.freeze({ file: 'tectonic-0.17.0-x86_64-apple-darwin.tar.gz', sha256: '7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80', entry: 'tectonic' })
});

// Upstream license at the pinned release tag; retained beside the runtime.
const licenseSource = 'https://raw.githubusercontent.com/tectonic-typesetting/tectonic/tectonic%400.17.0/LICENSE';
const license = `(Tectonic is licensed under the MIT License. Elements of the system from which
it is derived are licensed under an extremely wide variety of open-source
licenses.)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Tectonic download failed: HTTP ${response.status}.`);
  if (!response.body || Number(response.headers.get('content-length')) > maximumArchiveBytes) throw new Error('The Tectonic download is empty or too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximumArchiveBytes) throw new Error('The Tectonic archive exceeds the download limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function extractExecutable(archive, bytes, source) {
  if (source.file.endsWith('.zip')) {
    let JSZip;
    try { ({ default: JSZip } = await import('jszip')); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') throw new Error('JSZip is missing. Run npm ci in the Omni project folder, then run npm run latex:setup again.');
      throw error;
    }
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const entry = zip.file(source.entry);
    if (!entry || entry.dir) throw new Error(`The verified archive has no ${source.entry}.`);
    return entry.async('nodebuffer');
  }
  try {
    // Read only the known binary to stdout; no archive paths are written to disk.
    const result = await execute('tar', ['-xOzf', archive, source.entry], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, timeout: 120000, windowsHide: true, shell: false });
    return result.stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('The tar command is required to unpack Tectonic on Linux and macOS. Install tar and retry npm run latex:setup.');
    throw new Error(`Unable to extract the verified Tectonic archive: ${error.message}`);
  }
}

function validateExecutable(bytes, platform) {
  if (!bytes.length || bytes.length > 128 * 1024 * 1024) throw new Error('The extracted Tectonic executable is empty or too large.');
  const magic = bytes.subarray(0, 4).toString('hex');
  const valid = platform === 'win32' ? bytes.subarray(0, 2).toString() === 'MZ'
    : platform === 'linux' ? magic === '7f454c46'
      : ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(magic);
  if (!valid) throw new Error('The extracted Tectonic file is not an executable for the selected platform.');
}

/** Download a portable compiler for this host; no system installation or TeX execution. */
export async function setupLatex({ platform = process.platform, arch = process.arch, log = console.log } = {}) {
  const key = `${platform}-${arch}`, source = TECTONIC_DOWNLOADS[key];
  if (!source) throw new Error(`No pinned Tectonic runtime is available for ${key}. Install Tectonic separately and configure OMNI_TECTONIC_PATH.`);
  const target = path.join(project, 'desktop', 'latex-runtime');
  const executable = path.join(target, source.entry), marker = path.join(target, 'TECTONIC-SOURCE.json');
  try {
    const current = JSON.parse(await readFile(marker, 'utf8'));
    if (current.version === TECTONIC_VERSION && current.platform === key && current.sha256 === source.sha256 && current.executableSha256 === digest(await readFile(executable))) {
      await writeFile(path.join(target, 'TECTONIC-LICENSE.txt'), license);
      log(`Tectonic ${TECTONIC_VERSION} is ready (verified local runtime).`);
      return executable;
    }
  } catch { /* A missing or modified runtime is replaced only after verification. */ }

  const cacheRoot = path.join(project, '.tools');
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(cacheRoot, 'latex-setup-'));
  try {
    log(`Downloading Tectonic ${TECTONIC_VERSION} for ${key}...`);
    const bytes = await download(release + source.file);
    if (digest(bytes) !== source.sha256) throw new Error('Tectonic checksum mismatch. The downloaded archive was not unpacked.');
    const archive = path.join(temporary, source.file);
    await writeFile(archive, bytes);
    const binary = await extractExecutable(archive, bytes, source);
    validateExecutable(binary, platform);
    const staged = path.join(temporary, source.entry);
    await writeFile(staged, binary);
    if (platform !== 'win32') await chmod(staged, 0o755);
    await mkdir(target, { recursive: true });
    await rename(staged, executable);
    await writeFile(path.join(target, 'TECTONIC-LICENSE.txt'), license);
    await writeFile(marker, JSON.stringify({ version: TECTONIC_VERSION, platform: key, archive: release + source.file, sha256: source.sha256, executableSha256: digest(binary), license: 'MIT; derived components retain their upstream licenses', licenseSource, source: 'https://github.com/tectonic-typesetting/tectonic/tree/tectonic%400.17.0' }, null, 2) + '\n');
    log(`Tectonic is ready: ${executable}`);
    log('LaTeX packages are downloaded and cached by the compiler when first used. A warm cache is required for offline compilation.');
    return executable;
  } finally {
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(cacheRoot) || !path.basename(resolved).startsWith('latex-setup-')) throw new Error('Refusing to clean an unexpected setup directory.');
    await rm(resolved, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await setupLatex(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
