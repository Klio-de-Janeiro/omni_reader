const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_SOURCE = 8 * 1024 * 1024;
const inside = (root, file) => { const relative = path.relative(root, file); return !!relative && !path.isAbsolute(relative) && !relative.split(path.sep).includes('..'); };

/** Atomically replace an explicitly selected source, refusing external edits. */
async function saveLatexFile(file, bytes, expected) {
  if (path.extname(file).toLowerCase() !== '.tex' || bytes.length > MAX_SOURCE || expected.length > MAX_SOURCE) throw new Error('Исходник TeX должен быть не больше 8 МиБ.');
  const actual = await fs.realpath(file), stat = await fs.stat(actual);
  if (!stat.isFile() || stat.size > MAX_SOURCE || !(await fs.readFile(actual)).equals(expected)) throw new Error('Файл изменён другой программой. Откройте его заново или сохраните копию.');
  const temporary = path.join(path.dirname(actual), '.' + path.basename(actual) + '.omni-' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', stat.mode);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    if (!(await fs.readFile(actual)).equals(expected)) throw new Error('Файл изменён во время сохранения. Сохраните копию.');
    await fs.rename(temporary, actual);
  } finally { if (handle) await handle.close(); await fs.rm(temporary, { force: true }); }
}

/** A chosen destination is committed only after the complete new source is on disk. */
async function saveLatexDestination(file, bytes) {
  if (path.extname(file).toLowerCase() !== '.tex' || bytes.length > MAX_SOURCE) throw new Error('Выберите исходник .tex не больше 8 МиБ.');
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_SOURCE) throw new Error('Выбранный исходник слишком большой или недоступен.');
    return await saveLatexFile(file, bytes, await fs.readFile(file));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = await fs.realpath(path.dirname(file)), target = path.join(parent, path.basename(file));
  const temporary = path.join(parent, '.' + path.basename(file) + '.omni-' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await fs.open(temporary, 'wx'); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    // Exclusive copying also works on volumes that do not support hard links.
    // It refuses a file created by another application during Save As.
    await fs.copyFile(temporary, target, constants.COPYFILE_EXCL);
  } finally { if (handle) await handle.close(); await fs.rm(temporary, { force: true }); }
}

/** Snapshot statically referenced companions; never enumerate a user's entire folder. */
async function collectLatexFiles(file, source) {
  const root = await fs.realpath(path.dirname(file)), files = [], seen = new Set([path.basename(file)]);
  let total = 0;
  async function visit(text, depth = 0) {
    if (depth > 12) throw new Error('Слишком глубокая вложенность файлов TeX.');
    const graphicPaths = [...text.matchAll(/\\graphicspath\s*\{((?:\s*\{[^}]*\}\s*)+)\}/g)].flatMap(match => [...match[1].matchAll(/\{([^}]*)\}/g)].map(value => value[1]));
    const references = /\\(input|include|includegraphics|bibliography|addbibresource|documentclass|usepackage)(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g;
    for (const match of text.replace(/(?<!\\)%[^\r\n]*/g, '').matchAll(references)) {
      for (const raw of match[2].split(',')) {
        const name = raw.trim().replaceAll('\\', '/');
        if (!name || name.includes('..') || /^[/.]|:|[\u0000-\u001f{}#]/.test(name)) continue;
        const extensions = path.extname(name) ? [''] : ['include', 'input'].includes(match[1]) ? ['.tex'] : match[1] === 'documentclass' ? ['.cls'] : match[1] === 'usepackage' ? ['.sty'] : ['bibliography', 'addbibresource'].includes(match[1]) ? ['.bib'] : ['.pdf', '.png', '.jpg', '.jpeg'];
        const prefixes = match[1] === 'includegraphics' ? ['', ...graphicPaths] : [''];
        let found = false;
        for (const prefix of prefixes) {
          for (const extension of extensions) {
            const relative = prefix + name + extension;
            if (seen.has(relative)) { found = true; break; }
            const target = path.resolve(root, relative);
            if (!inside(root, target)) continue;
            let actual, stat;
            try { actual = await fs.realpath(target); stat = await fs.stat(actual); } catch { continue; }
            if (!inside(root, actual) || !stat.isFile()) continue;
            if (files.length >= 256 || stat.size > 32 * 1024 * 1024 || total + stat.size > 64 * 1024 * 1024) throw new Error('Файлы проекта превышают лимит 64 МиБ или 256 файлов.');
            const bytes = await fs.readFile(actual); total += bytes.length;
            if (total > 64 * 1024 * 1024) throw new Error('Файлы проекта превышают лимит 64 МиБ.');
            seen.add(relative); files.push({ path: relative, bytes }); found = true;
            if (/\.(tex|sty|cls)$/i.test(relative)) await visit(bytes.toString('utf8'), depth + 1);
            break;
          }
          if (found) break;
        }
      }
    }
  }
  await visit(source);
  return files;
}
module.exports = { saveLatexFile, saveLatexDestination, collectLatexFiles };
