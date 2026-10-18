import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts } from '../../dist/vendor/pdf-lib.js';
import { LatexService } from '../../desktop/latex.cjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.OMNI_CHROMIUM });
const root = path.resolve('dist'), base = 'https://omni.test';
const real = process.env.OMNI_REAL_LATEX === '1';
const service = new LatexService({ runtimeDir:'desktop/latex-runtime', cacheDir:'.tools/latex-cache' });
const source = await readFile('tests/fixtures/sample.tex', 'utf8');
await mkdir('test-results/latex', { recursive: true });
const builds = [];
try {
  const context = await browser.newContext({ viewport:{width:1440,height:1000} });
  await context.addInitScript(initial => {
    // Keep app focus mode, while allowing viewport changes in headless Chromium.
    Element.prototype.requestFullscreen = async () => {};
    window.__texSaves = [];
    let saved = initial;
    const handle = {
      queryPermission:async () => 'granted',
      getFile:async () => new File([saved],'sample.tex'),
      createWritable:async () => {
        let pending;
        return { write:async data => { pending=await new Blob([data]).text(); }, close:async () => {saved=pending;window.__texSaves.push(saved);}, abort:async () => {} };
      }
    };
    window.showSaveFilePicker = async () => handle;
  }, source);
  await context.route(base + '/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/latex/status') return route.fulfill({ json:{ available:true, engine:'Tectonic' } });
    if (url.pathname === '/api/latex/compile') {
      const request=route.request().postDataJSON(); builds.push(request);
      let result;
      if (real) result=await service.compile({...request,files:[]});
      else if (request.source.includes('BROKEN')) result={ok:false,log:'! Undefined control sequence\nl.4 BROKEN',diagnostics:[{line:4,message:'Undefined control sequence',severity:'error'}]};
      else {
        const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
        pdf.addPage([420,594]).drawText(request.source.includes('changed')?'Omni changed':'Omni LaTeX',{x:36,y:540,size:18,font});
        result={ok:true,pdf:await pdf.save(),engine:'Tectonic',log:'Compiled',diagnostics:[]};
      }
      return route.fulfill({json:{...result,pdf:result.pdf?Buffer.from(result.pdf).toString('base64'):null}});
    }
    const file=path.resolve(root,'.'+url.pathname);
    if (!file.startsWith(root+path.sep)) return route.abort();
    try {
      const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.woff2':'font/woff2','.wasm':'application/wasm','.png':'image/png'};
      await route.fulfill({contentType:types[path.extname(file)]||'application/octet-stream',body:await readFile(file)});
    } catch { await route.fulfill({status:404,body:'Not found'}); }
  });
  const page=await context.newPage(), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/index.html'); await page.locator('#remember').uncheck();
  await page.locator('#file-input').setInputFiles('tests/fixtures/sample.tex');
  const editor=page.locator('.latex-editor'),input=page.getByLabel('Исходный текст LaTeX',{exact:true}),compile=page.getByRole('button',{name:'Компилировать',exact:true});
  await editor.waitFor(); await input.waitFor();
  assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('focus-mode')),true);
  assert.equal(await input.inputValue(),source.replace(/\r\n/g,'\n'));
  assert.equal(await compile.isVisible(),true); assert.equal(await compile.isDisabled(),true);
  await page.getByLabel('Доверяю этому TeX-проекту').check();
  await compile.click();
  await page.waitForFunction(()=>document.querySelector('.latex-status')?.textContent.startsWith('PDF готов'),{},{timeout:310000});
  await page.locator('.latex-pdf-viewer .textLayer span').first().waitFor();
  await page.screenshot({path:'test-results/latex/editor-success.png',fullPage:true});
  assert.equal(builds.length,1); assert.equal(builds[0].trusted,true);
  const before=await input.boundingBox(),after=await page.locator('.latex-preview-pane').boundingBox(); assert.ok(before.x+before.width<=after.x+10);
  await input.fill(source.replace('Hello Omni','Hello Omni changed'));
  await page.locator('.latex-stale').waitFor();
  await page.getByRole('button',{name:'Сохранить .tex',exact:true}).click();
  await page.waitForFunction(()=>window.__texSaves.length===1);
  assert.equal(await page.locator('.file-open').count(),1);
  assert.equal(await page.locator('#reader-name').textContent(),'sample.tex');
  await compile.click();
  await page.waitForFunction(()=>document.querySelector('.latex-status')?.textContent.startsWith('PDF готов'),{},{timeout:310000});
  const good=await page.locator('.latex-pdf-viewer').innerText();
  await input.fill(source.replace('\\end{document}','\\BROKEN\n\\end{document}')); await compile.click();
  await page.waitForFunction(()=>document.querySelector('.latex-status')?.textContent.startsWith('Ошибка компиляции'),{},{timeout:310000});
  assert.equal(await page.locator('.latex-pdf-viewer').innerText(),good);
  assert.ok((await input.inputValue()).includes('BROKEN'));
  await page.locator('.latex-mode-source').click(); assert.equal(await page.locator('.latex-preview-pane').isVisible(),false);
  await page.locator('.latex-mode-preview').click(); assert.equal(await input.isVisible(),false);
  await page.keyboard.press('Control+s'); await page.waitForFunction(()=>window.__texSaves.length===2);
  assert.equal(await page.locator('.file-open').count(),1);
  await page.locator('.latex-mode-split').click();
  await page.screenshot({path:'test-results/latex/editor-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await compile.isVisible(),true);
  for (const mode of ['source','preview','split']) { await page.locator('.latex-mode-'+mode).click(); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)); }
  await page.screenshot({path:'test-results/latex/editor-mobile.png',fullPage:true});
  // Old persisted copies can contain a native token from a previous app session.
  await page.evaluate(async source => {
    const db = await new Promise((resolve,reject) => { const req=indexedDB.open('omni-reader',1);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error); });
    await new Promise((resolve,reject) => {
      const tx=db.transaction('files','readwrite');
      tx.objectStore('files').put({id:'restored-tex',name:'restored.tex',ext:'tex',blob:new Blob([source]),size:source.length,nativeUrl:'omni://app/native/expired-token',images:{},opened:Date.now()});
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    }); db.close();
  },source);
  await page.reload(); await page.getByRole('button',{name:'Открыть restored.tex',exact:true}).click();
  await editor.waitFor(); await page.getByLabel('Доверяю этому TeX-проекту').check(); await compile.click();
  await page.waitForFunction(()=>document.querySelector('.latex-status')?.textContent.startsWith('PDF готов'),{},{timeout:310000});
  assert.equal(builds.at(-1).nativeUrl,undefined);
  assert.deepEqual(errors,[]);
  await writeFile('test-results/latex/browser-result.json',JSON.stringify({passed:true,realCompiler:real,builds:builds.length,checks:['split/source/preview','real PDF rendering','compile changed draft','retained PDF on error','save in place from source and preview','visible focus controls','mobile 390px']},null,2));
  console.log('LaTeX browser flow passed'+(real?' with real Tectonic':'')+'.');
} finally { service.dispose(); await browser.close(); }
