import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { syncBranding } from './branding.mjs';
await syncBranding();
await build({ entryPoints: ['scripts/editors-entry.js'], alias: { sax: './vendor-sources/sax/lib/sax.js' }, bundle: true, minify: true, format: 'esm', outfile: 'dist/vendor/editors.js', platform: 'browser', target: 'es2022', legalComments: 'linked' });
await cp('vendor-sources/pdf-lib/pdf-lib.esm.js', 'dist/vendor/pdf-lib.js');
await build({ entryPoints: ['scripts/xlsx-entry.js'], alias: { sax: './vendor-sources/sax/lib/sax.js' }, bundle: true, minify: true, format: 'esm', outfile: 'dist/vendor/xlsx.js', platform: 'browser', target: 'es2022', legalComments: 'linked' });
await mkdir('dist/vendor/pdf', { recursive: true });
await build({ entryPoints: ['scripts/office-entry.js'], bundle: true, minify: true, format: 'iife', outfile: 'dist/vendor/office.js', platform: 'browser', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'linked' });
await build({ entryPoints: ['scripts/markdown-entry.js'], bundle: true, minify: true, format: 'esm', outfile: 'dist/vendor/markdown.js', platform: 'browser', target: 'es2022', legalComments: 'linked' });
await mkdir('dist/vendor/katex', { recursive: true });
await cp('vendor-sources/katex/dist/fonts', 'dist/vendor/katex/fonts', { recursive: true });
const mathCss = (await readFile('vendor-sources/katex/dist/katex.min.css', 'utf8')).replace(/,url\([^)]*\) format\("(?:woff|truetype)"\)/g, '');
await writeFile('dist/vendor/katex/katex.min.css', mathCss);
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) await cp(`node_modules/pdfjs-dist/legacy/build/${name}`, `dist/vendor/pdf/${name}`);
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${folder}`, `dist/vendor/pdf/${folder}`, { recursive: true });
await mkdir('dist/licenses', { recursive: true });
for (const name of ['jszip', 'pdfjs-dist', 'docx-preview', '@aiden0z/pptx-renderer']) {
  const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.md']) {
    try { await cp(`node_modules/${name}/${file}`, `dist/licenses/${name.replaceAll('/', '-')}-${file}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(`dist/licenses/${name.replaceAll('/', '-')}.json`, JSON.stringify({name,version:pkg.version,license:pkg.license,repository:pkg.repository}, null, 2));
}
/** Recursively collect public files for the offline cache. */
async function collect(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await collect(path));
    else if (!['sw.js', '_headers'].includes(entry.name)) result.push(path);
  }
  return result.sort();
}
await cp('node_modules/@aiden0z/pptx-renderer/licenses', 'dist/licenses/pptx-third-party', { recursive: true });
await mkdir('dist/fonts', { recursive: true });
for (const subset of ['latin', 'cyrillic']) await cp(`node_modules/@fontsource-variable/inter/files/inter-${subset}-wght-normal.woff2`, `dist/fonts/inter-${subset}.woff2`);
await cp('node_modules/@fontsource-variable/inter/LICENSE', 'dist/licenses/Inter-OFL.txt');
for (const name of ['xml-js', 'sax', 'pdf-lib', 'marked', 'katex', 'dompurify']) await cp(`vendor-sources/${name}`, `dist/licenses/vendor-${name}`, { recursive: true });
const officeCode = (await readFile('dist/vendor/office.js', 'utf8')).replace(/<\/script/gi, '<\\/script');
const officeHash = createHash('sha256').update(officeCode).digest('base64');
const officeTemplate = await readFile('scripts/office-template.html', 'utf8');
await writeFile('dist/office.html', officeTemplate.replace("script-src 'self'", `script-src 'sha256-${officeHash}'`).replace('<script src="./vendor/office.js"></script>', () => `<script>${officeCode}</script>`));
const indexHtml = await readFile('dist/index.html', 'utf8');
await writeFile('dist/index.html', indexHtml.replace(/script-src [^;]+;/, `script-src 'self' 'sha256-${officeHash}';`));
await cp('node_modules/pdfjs-dist/web/pdf_viewer.css', 'dist/vendor/pdf-viewer.css');
const files = await collect('dist');
const hash = createHash('sha256');
for (const path of files) hash.update(await readFile(path));
const version = hash.digest('hex').slice(0, 12);
const template = await readFile('scripts/sw-template.js', 'utf8');
await writeFile('dist/sw.js', template.replace('__VERSION__', version).replace('__ASSETS__', JSON.stringify(['./', ...files.map(path => './' + path.slice(5))])));
console.log(`Built ${files.length} local assets; offline cache ${version}`);
