const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn: spawnProcess } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const ENGINE = 'Tectonic';
const LIMITS = Object.freeze({ source: 8 * 1024 * 1024, assets: 64 * 1024 * 1024, files: 256, log: 5 * 1024 * 1024, pdf: 50 * 1024 * 1024, timeout: 300000 });
const executableName = name => /^tectonic(?:\.exe)?$/i.test(name);
const deviceName = name => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const inside = (root, target) => target.startsWith(root + path.sep);
const abortError = () => Object.assign(new Error('Компиляция отменена.'), { name: 'AbortError' });

/** Turn native TeX diagnostics into editor locations without interpreting their content. */
function parseDiagnostics(log) {
  const clean = String(log).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');
  const diagnostics = [], seen = new Set();
  const add = (line, message, severity = 'error') => {
    message = message.trim().slice(0, 2000);
    if (!message || diagnostics.length >= 200) return;
    line = Number.isSafeInteger(line) && line > 0 ? line : null;
    const key = `${line}:${severity}:${message}`;
    if (!seen.has(key)) { seen.add(key); diagnostics.push({ line, message, severity }); }
  };
  let pending;
  for (const raw of clean.split('\n')) {
    const text = raw.trim();
    const located = text.match(/^(?:(error|warning):\s*)?.*?\.tex:(\d+)(?::\d+)?:\s*(.+)$/i);
    if (located) { add(Number(located[2]), located[3], located[1]?.toLowerCase() === 'warning' || /warning/i.test(located[3]) ? 'warning' : 'error'); continue; }
    if (text.startsWith('!')) { if (pending) add(null, pending); pending = text.slice(1).trim(); continue; }
    const line = text.match(/^l\.(\d+)\b/);
    if (line && pending) { add(Number(line[1]), pending); pending = undefined; continue; }
    const warning = text.match(/^(?:(?:LaTeX|Package\s+\S+)\s+Warning:|warning:)\s*(.+)$/i);
    if (warning) { const at = text.match(/(?:on input line|at lines?)\s+(\d+)/i); add(at ? Number(at[1]) : null, warning[1], 'warning'); continue; }
    const box = text.match(/^(?:Overfull|Underfull)\s+\\[hv]box\b.*?(?:at lines?\s+(\d+))?/i);
    if (box) { const at = text.match(/at lines?\s+(\d+)/i); add(at ? Number(at[1]) : null, text, 'warning'); continue; }
    const error = text.match(/^error:\s*(.+)$/i);
    if (error) add(null, error[1]);
  }
  if (pending) add(null, pending);
  return diagnostics;
}

/** Input files are byte snapshots; no renderer-supplied path is ever read from disk. */
function validateInput(input) {
  if (!input || typeof input !== 'object' || typeof input.source !== 'string') throw new Error('Неверный исходный текст LaTeX.');
  if (Buffer.byteLength(input.source, 'utf8') > LIMITS.source) throw new Error('Исходный текст LaTeX должен быть не больше 8 МиБ.');
  const name = typeof input.name === 'string' ? input.name.normalize('NFC') : 'main.tex';
  if (!name || name.length > 180 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || deviceName(name) || !/\.tex$/i.test(name)) throw new Error('Имя основного файла должно быть простым именем .tex без пути.');
  // Prefix option-like names, retaining the basename expected by relative project inputs.
  const main = name.startsWith('-') ? `document${name}` : name;
  const files = input.files === undefined ? [] : input.files;
  if (!Array.isArray(files) || files.length > LIMITS.files) throw new Error('В проекте LaTeX может быть не больше 256 дополнительных файлов.');
  const occupied = new Set([main.toLowerCase()]), snapshots = [];
  const stem = main.replace(/\.tex$/i, '').toLowerCase();
  const reserved = new Set(['output', ...['pdf', 'log', 'aux', 'xdv', 'bbl', 'blg', 'fls', 'fmt', 'out', 'toc', 'synctex.gz'].map(ext => `${stem}.${ext}`)]);
  let total = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => !['path', 'bytes'].includes(key)) || typeof file.path !== 'string') throw new Error('Дополнительный файл должен содержать только путь и содержимое; ссылки не поддерживаются.');
    const relative = file.path.normalize('NFC'), parts = relative.split('/');
    if (!relative || relative.length > 512 || /[<>:"\\|?*\x00-\x1f]/.test(relative) || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || deviceName(part))) throw new Error('Недопустимый относительный путь файла проекта.');
    const key = relative.toLowerCase();
    if (reserved.has(parts[0].toLowerCase()) || occupied.has(key)) throw new Error('Имя файла проекта совпадает с исходником или зарезервированным результатом.');
    for (const existing of occupied) if (key.startsWith(existing + '/') || existing.startsWith(key + '/')) throw new Error('Пути файлов проекта пересекаются.');
    const bytes = typeof file.bytes === 'string' ? Buffer.from(file.bytes, 'utf8') : file.bytes instanceof Uint8Array ? Buffer.from(file.bytes) : null;
    if (!bytes) throw new Error('Содержимое файла проекта должно быть текстом или массивом байтов.');
    total += bytes.byteLength;
    if (total > LIMITS.assets) throw new Error('Дополнительные файлы LaTeX должны занимать не больше 64 МиБ.');
    occupied.add(key); snapshots.push({ path: relative, bytes });
  }
  return { main, source: Buffer.from(input.source, 'utf8'), files: snapshots };
}

function textFromBuffers(parts, limit = LIMITS.log) {
  // A cut multibyte character is deliberately omitted at the hard byte limit.
  const text = new StringDecoder('utf8').write(Buffer.concat(parts));
  const normalized = Buffer.from(text, 'utf8');
  return normalized.length <= limit ? text : new StringDecoder('utf8').write(normalized.subarray(0, limit));
}

async function readPrefix(handle, size) {
  const buffer = Buffer.alloc(size); let total = 0;
  while (total < size) {
    const read = await handle.read(buffer, total, size - total, total);
    if (!read.bytesRead) break;
    total += read.bytesRead;
  }
  return buffer.subarray(0, total);
}

/** Local TeX execution uses --untrusted; it is not an operating-system filesystem sandbox. */
class LatexService {
  constructor({ runtimeDir, cacheDir, compilerPath, spawn, timeoutMs = LIMITS.timeout } = {}) {
    this.runtimeDir = path.resolve(runtimeDir || path.join(__dirname, 'latex-runtime'));
    this.cacheDir = path.resolve(cacheDir || path.join(os.tmpdir(), 'omni-latex'));
    this.jobsDir = path.join(this.cacheDir, 'jobs');
    this.compilerPath = compilerPath;
    this.spawn = spawn || spawnProcess;
    this.timeoutMs = Math.max(1, Math.min(LIMITS.timeout, Number.isFinite(timeoutMs) ? timeoutMs : LIMITS.timeout));
    this.job = null; this.disposed = false;
  }

  async findCompiler() {
    const explicit = [this.compilerPath, process.env.OMNI_TECTONIC_PATH, process.env.OMNI_TECTONIC].filter(value => typeof value === 'string' && value.trim());
    const names = process.platform === 'win32' ? ['tectonic.exe', 'tectonic'] : ['tectonic', 'tectonic.exe'];
    const candidates = [...explicit, ...names.map(name => path.join(this.runtimeDir, name))];
    for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) for (const name of names) candidates.push(path.join(directory.replace(/^"|"$/g, ''), name));
    for (const candidate of candidates) {
      if (!executableName(path.basename(candidate))) continue;
      const absolute = path.resolve(candidate);
      try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile()) continue;
        await fs.access(absolute, constants.X_OK);
        return absolute;
      } catch { /* Missing optional runtimes do not block source editing. */ }
    }
    return null;
  }

  async status() {
    const available = !!await this.findCompiler();
    return { available, engine: ENGINE, message: available ? 'Tectonic готов к компиляции.' : 'Tectonic не найден. Выполните npm run latex:setup в папке Omni, затем откройте TeX заново.' };
  }

  async terminate(child) {
    if (!child?.pid) return;
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      return;
    }
    await new Promise(resolve => {
      let killer, timer, settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} resolve(); };
      try {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        killer = this.spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', finish); killer.once('close', finish);
        timer = setTimeout(() => { try { killer.kill(); } catch {} finish(); }, 3000);
      } catch { finish(); }
    });
  }

  async execute(compiler, main, directory, output, signal, job) {
    const parts = []; let bytes = 0, child, timer, failure, termination;
    const stop = reason => { if (failure) return; failure = reason; termination = this.terminate(child); };
    job.cancel = () => stop('abort');
    const onAbort = () => stop('abort');
    const add = data => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data), remaining = LIMITS.log - bytes;
      if (remaining > 0) { const chunk = buffer.subarray(0, remaining); parts.push(chunk); bytes += chunk.length; }
      if (buffer.length > remaining) stop('log');
    };
    let processError;
    const exit = await new Promise(resolve => {
      try {
        child = this.spawn(compiler, ['--untrusted', '--keep-logs', '--outdir', output, main], {
          cwd: directory, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, TECTONIC_CACHE_DIR: path.join(this.cacheDir, 'resources'), TECTONIC_UNTRUSTED_MODE: '1', RUST_BACKTRACE: '0' }
        });
        child.stdout?.on('data', add); child.stderr?.on('data', add);
        child.once('error', error => { processError = error; if (!child.pid) resolve({ code: null }); });
        child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
        timer = setTimeout(() => stop('timeout'), this.timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted || job.cancelled) stop('abort');
      } catch (error) { processError = error; resolve({ code: null }); }
    });
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    if (termination) await termination;
    job.cancel = null;
    return { ...exit, failure, error: processError, parts, bytes };
  }

  async compile(input, { signal } = {}) {
    if (this.disposed) throw new Error('Сервис LaTeX закрыт.');
    if (this.job) throw new Error('Компиляция LaTeX уже выполняется. Дождитесь её завершения.');
    const snapshot = validateInput(input), job = { directory: null, cancel: null, cancelled: false };
    this.job = job;
    const failed = message => ({ ok: false, pdf: null, log: message, diagnostics: [{ line: null, message, severity: 'error' }], engine: ENGINE });
    try {
      if (signal?.aborted || this.disposed) throw abortError();
      const compiler = await this.findCompiler();
      if (signal?.aborted || job.cancelled || this.disposed) throw abortError();
      if (!compiler) return failed('Tectonic не найден. Установите компилятор LaTeX для создания PDF.');
      await fs.mkdir(this.jobsDir, { recursive: true });
      await fs.mkdir(path.join(this.cacheDir, 'resources'), { recursive: true });
      job.directory = await fs.mkdtemp(path.join(this.jobsDir, 'job-'));
      const output = path.join(job.directory, 'output'); await fs.mkdir(output);
      await fs.writeFile(path.join(job.directory, snapshot.main), snapshot.source, { flag: 'wx' });
      for (const file of snapshot.files) {
        const target = path.resolve(job.directory, file.path);
        if (!inside(job.directory, target)) throw new Error('Файл проекта находится за пределами временной папки.');
        await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.bytes, { flag: 'wx' });
      }
      if (signal?.aborted || job.cancelled || this.disposed) throw abortError();
      const run = await this.execute(compiler, snapshot.main, job.directory, output, signal, job);
      if (run.failure === 'abort' || signal?.aborted || job.cancelled || this.disposed) throw abortError();
      const stem = snapshot.main.replace(/\.tex$/i, '');
      let logOverflow = run.failure === 'log';
      const logfile = path.join(output, stem + '.log');
      try {
        const stat = await fs.lstat(logfile);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          const remaining = LIMITS.log - run.bytes;
          if (stat.size > remaining) logOverflow = true;
          if (remaining > 0 && stat.size) {
            const handle = await fs.open(logfile, 'r');
            try { run.parts.push(await readPrefix(handle, Math.min(remaining, stat.size))); }
            finally { await handle.close(); }
          }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let log = textFromBuffers(run.parts), problem;
      if (run.failure === 'timeout') problem = `Время компиляции LaTeX истекло (лимит ${Math.ceil(this.timeoutMs / 1000)} с).`;
      else if (logOverflow) problem = 'Журнал компиляции превысил лимит 5 МиБ.';
      else if (run.error) problem = 'Не удалось запустить Tectonic: ' + run.error.message;
      else if (run.code !== 0) problem = `Tectonic завершился с ошибкой${Number.isInteger(run.code) ? ' (код ' + run.code + ')' : ''}.`;
      let pdf = null;
      if (!problem) {
        try {
          const filename = path.join(output, stem + '.pdf'), stat = await fs.lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.pdf || stat.size < 5) throw new Error('Некорректный PDF или результат больше 50 МиБ.');
          const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          let bytes;
          try { bytes = await readPrefix(handle, stat.size + 1); }
          finally { await handle.close(); }
          if (bytes.length !== stat.size || !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Tectonic не создал корректный PDF.');
          pdf = new Uint8Array(bytes);
        } catch (error) { problem = error.code === 'ENOENT' ? 'Tectonic завершился без PDF. Проверьте исходный текст.' : error.message; }
      }
      const diagnostics = parseDiagnostics(log);
      if (problem) {
        if (!diagnostics.some(item => item.severity === 'error')) diagnostics.push({ line: null, message: problem, severity: 'error' });
        // Always reserve room for a concise reason even when subprocess output filled the limit.
        const reason = Buffer.from('\n' + problem, 'utf8'), current = Buffer.from(log, 'utf8');
        log = textFromBuffers([current.subarray(0, Math.max(0, LIMITS.log - reason.length))], Math.max(0, LIMITS.log - reason.length)) + reason.toString('utf8');
      }
      if (signal?.aborted || job.cancelled || this.disposed) throw abortError();
      return { ok: !problem, pdf: problem ? null : pdf, log, diagnostics, engine: ENGINE };
    } finally {
      try {
        if (job.directory) {
          const target = path.resolve(job.directory);
          if (!inside(this.jobsDir, target) || path.dirname(target) !== this.jobsDir || !path.basename(target).startsWith('job-')) throw new Error('Небезопасная папка очистки LaTeX.');
          await fs.rm(target, { recursive: true, force: true });
        }
      } finally { if (this.job === job) this.job = null; }
    }
  }

  dispose() {
    this.disposed = true;
    if (this.job) { this.job.cancelled = true; this.job.cancel?.(); }
  }
}

module.exports = { LatexService, parseDiagnostics, LIMITS };
