import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openOfficeEditor, openXlsxEditor } from '../../dist/vendor/editors.js';
import { PDFDocument } from '../../dist/vendor/pdf-lib.js';
import { readWav } from '../../dist/editors/wav.js';
import { parseCsv } from '../../dist/table-core.js';
const base = 'https://omni.test';
const root = path.resolve('dist');
const browser = await chromium.launch({ headless: true, executablePath: process.env.OMNI_CHROMIUM });
const results = [];
await mkdir('test-results', { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.__exports = [];
    window.omniDesktop = { save: async input => { window.__exports.push({ name: input.name, bytes: Array.from(new Uint8Array(input.bytes)) }); return true; }, onFiles: () => {} };
  });
  await context.route(`${base}/**`, async route => {
    const requested = path.resolve(root, '.' + new URL(route.request().url()).pathname);
    if (!requested.startsWith(root + path.sep)) { await route.abort(); return; }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
    try { await route.fulfill({ status: 200, contentType: types[path.extname(requested)] || 'application/octet-stream', body: await readFile(requested) }); }
    catch { await route.fulfill({ status: 404, body: 'Not found' }); }
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/index.html');
  await page.locator('#remember').uncheck();
  async function waitFor(predicate) {
    const until = Date.now() + 35000;
    while (Date.now() < until) { if (await page.evaluate(predicate)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Application state timeout');
  }
  async function open(ext) {
    await page.locator('#file-input').setInputFiles(`tests/fixtures/sample.${ext}`);
    await page.locator('#reader-name').filter({ hasText: `sample.${ext}` }).waitFor();
    await waitFor(() => document.querySelector('#viewer').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('.error-state').count(), 0, await page.locator('#viewer').innerText());
  }
  await page.screenshot({ path: 'test-results/neon-desktop.png', fullPage: true });
  for (const ext of ['pdf', 'docx', 'pptx', 'wav', 'jpg', 'png', 'xlsx', 'csv']) {
    await open(ext);
    if(['pdf','docx','pptx'].includes(ext)){
      assert.equal(await page.locator('#view-mode').inputValue(),'scroll');
      await page.locator('#view-mode').selectOption('page');
      await page.waitForFunction(()=>!document.querySelector('#view-mode').disabled);
      await page.locator('#view-mode').selectOption('scroll');
      await page.waitForFunction(()=>!document.querySelector('#view-mode').disabled);
      assert.equal(await page.locator('#view-mode').inputValue(),'scroll');
    }
    if (ext === 'pdf') {
      assert.ok(await page.locator('.textLayer span').count() > 0);
      const selected = await page.locator('.textLayer span').first().evaluate(span => { const range = document.createRange(); range.selectNodeContents(span); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection.toString(); });
      assert.ok(selected.trim());
      await page.locator('#copy-selection').click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selected);
      await page.locator('#text-search').fill('PAGE 2'); await page.locator('#find-text').click();
      await waitFor(() => document.querySelector('#page').value === '2');
    }
    if (ext === 'docx' || ext === 'pptx') {
      await page.locator('#text-search').fill(ext === 'docx' ? 'Вторая страница' : 'слайд 2');
      await page.locator('#find-text').click();
      await waitFor(() => document.querySelector('#page').value === '2');
    }
    if (ext === 'wav') {
      await page.getByLabel('Перейти к времени').fill('0:01'); await page.getByRole('button', { name: 'Перейти', exact: true }).click();
      assert.ok(Math.abs(await page.locator('audio').evaluate(el => el.currentTime) - 1) < .1);
    }
    if (ext === 'xlsx') {
      await page.getByLabel('Адрес или диапазон ячеек').fill('B250'); await page.getByRole('button', { name: 'Перейти', exact: true }).click();
      assert.match(await page.locator('.cell-detail').innerText(), /2500/);
      await page.getByLabel('Адрес или диапазон ячеек').fill('A1:B2'); await page.getByRole('button', { name: 'Перейти', exact: true }).click();
      await page.getByRole('button', { name: 'Копировать диапазон' }).click();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Клио\t42/);
      await page.getByLabel('Лист книги').selectOption('1');
      assert.match(await page.locator('.table-scroll').innerText(), /hello second sheet/);
      await page.screenshot({ path: 'test-results/neon-table.png', fullPage: true });
    }
    if (ext === 'csv') assert.match(await page.locator('.table-scroll').innerText(), /Клио/);
    results.push(`${ext}: interactive viewer`);
  }
  for (const ext of ['csv', 'xlsx', 'docx', 'pptx', 'pdf', 'wav', 'jpg', 'png']) {
    await page.getByRole('button', { name: `Открыть sample.${ext}`, exact: true }).first().click();
    await waitFor(() => document.querySelector('#viewer').getAttribute('aria-busy') === 'false');
    await page.locator('#edit-file').click();
    await page.locator('.editor-panel').waitFor();
    if (ext === 'csv' || ext === 'xlsx') {
      await page.getByLabel('Ячейка', { exact: true }).fill(ext === 'csv' ? 'A2' : 'B2');
      await page.getByRole('button', { name: 'Перейти к ячейке' }).click();
      await page.getByLabel('Значение ячейки', { exact: true }).fill(ext === 'csv' ? 'Edited CSV <&>' : '123.5');
      if (ext === 'csv') {
        await page.locator('#close').click(); await page.locator('#discard-dialog').waitFor();
        await page.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click();
        assert.equal(await page.getByLabel('Значение ячейки', { exact: true }).inputValue(), 'Edited CSV <&>');
      }
      await page.getByRole('button', { name: 'Применить ячейку' }).click();
      await page.getByRole('button', { name: 'Отменить', exact: true }).click();
      assert.notEqual(await page.getByLabel('Значение ячейки', { exact: true }).inputValue(), ext === 'csv' ? 'Edited CSV <&>' : '123.5');
      await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    } else if (ext === 'docx' || ext === 'pptx') {
      const content=page.frameLocator('.office-edit-canvas iframe').getByRole('textbox',{name:'Текст документа'}).first();
      await content.fill('Клио после правки');
      await content.evaluate(el=>{el.focus();const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));});
      for(const name of ['Жирный','Курсив','Подчёркивание','Зачёркивание'])await page.getByRole('button',{name,exact:true}).click();
      await page.getByLabel('Режим просмотра редактора').selectOption('page');
      await page.waitForFunction(()=>!document.querySelector('.office-editor select').disabled);
      await page.getByLabel('Режим просмотра редактора').selectOption('scroll');
      await page.waitForFunction(()=>!document.querySelector('.office-editor select').disabled);
      assert.equal(await page.frameLocator('.office-edit-canvas iframe').getByRole('textbox',{name:'Текст документа'}).first().textContent(),'Клио после правки');
      await page.locator('#focus-toggle').click();assert.match(await page.locator('body').getAttribute('class'),/focus-mode/);
      await page.locator('#focus-toggle').click();
    } else if (ext === 'pdf') {
      await page.getByRole('button', { name: 'Повернуть на 90°', exact: true }).click();
      await page.getByLabel('Редактируемая страница PDF').selectOption('1');
      await page.getByRole('button', { name: 'Убрать страницу', exact: true }).click();
    } else if (ext === 'wav') {
      await page.getByLabel('Начало, секунды', { exact: true }).fill('0.25');
      await page.getByLabel('Конец, секунды', { exact: true }).fill('1');
      await page.getByLabel('Громкость, dB', { exact: true }).fill('-6');
      await page.getByRole('button', { name: 'Применить звук' }).click();
    } else {
      await page.getByLabel('Ширина, px', { exact: true }).fill('100');
      await page.getByLabel('Высота, px', { exact: true }).fill('60');
      await page.getByRole('button', { name: 'Применить обрезку' }).click();
      await page.getByRole('button', { name: 'Повернуть на 90°', exact: true }).click();
    }
    await page.screenshot({ path: `test-results/editor-${ext}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Сохранить копию', exact: true }).click();
    await page.locator('#reader-name').filter({ hasText: `sample-edited-1.${ext}` }).waitFor();
    await page.waitForFunction(extension => window.__exports.some(item => item.name === `sample-edited-1.${extension}`), ext);
    const exported = await page.evaluate(extension => window.__exports.find(item => item.name === `sample-edited-1.${extension}`), ext);
    const bytes = Uint8Array.from(exported.bytes); await writeFile(`test-results/ui-edited.${ext}`, bytes);
    if (ext === 'csv') assert.equal(parseCsv(new TextDecoder().decode(bytes), ';')[1][0], 'Edited CSV <&>');
    if (ext === 'xlsx') assert.equal((await openXlsxEditor(bytes.buffer)).getCell(0, 'B2').value, '123.5');
    if (ext === 'docx' || ext === 'pptx'){
      const model=await openOfficeEditor(bytes.buffer,ext);assert.equal(model.getText(0),'Клио после правки');
      assert.deepEqual(model.getBlocks()[0].segments[0].style,{bold:true,italic:true,underline:true,strike:true});
    }
    if (ext === 'pdf') { const doc = await PDFDocument.load(bytes); assert.equal(doc.getPageCount(), 1); assert.equal(doc.getPage(0).getRotation().angle, 90); }
    if (ext === 'wav') assert.equal(readWav(bytes.buffer).frames, 12000);
    if (ext === 'jpg' || ext === 'png') {
      const size = await page.evaluate(async data => { const bitmap = await createImageBitmap(new Blob([Uint8Array.from(data)])); const size = [bitmap.width, bitmap.height]; bitmap.close(); return size; }, exported.bytes);
      assert.deepEqual(size, [60, 100]);
    }
    results.push(`${ext}: UI edit, save copy, reopen exported bytes`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'test-results/neon-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  results.push('mobile viewport and no uncaught browser exceptions');
  await writeFile('test-results/native-ui.json', JSON.stringify({ passed: results }, null, 2));
  console.log(results.join('\n'));
} finally { await browser.close(); }
