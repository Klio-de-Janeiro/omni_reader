import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { openOfficeEditor } from '../dist/vendor/editors.js';
import { bindZoomGestures, bindTouchPinch, createVisualZoom, captureZoomAnchor } from '../dist/gestures.js';
const fixture = await readFile(new URL('./fixtures/sample.docx', import.meta.url));
const array = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const bundle = await readFile(new URL('../dist/vendor/office.js', import.meta.url), 'utf8');
function touch(w, target, type, points) {
  const event = new w.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: points.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })) });
  target.dispatchEvent(event); return event;
}
for (const ext of ['docx','pptx']) for (const editing of [false, true]) test(`Bundled ${ext.toUpperCase()} entry opens and zooms: ` + (editing ? 'inline editor' : 'viewer'), async () => {
  const bytes=ext==='docx'?fixture:await readFile(new URL('./fixtures/sample.pptx',import.meta.url));
  const dom = new JSDOM('<!doctype html><div id="office"></div>', { pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window, messages = [], waiting = new Map();
  let pageJumps = 0;
  Object.assign(w, { TextEncoder, TextDecoder, structuredClone, ResizeObserver: class { observe() {} disconnect() {} } });
  w.HTMLCanvasElement.prototype.getContext = () => ({measureText:text=>({width:text.length*10,actualBoundingBoxAscent:10,actualBoundingBoxDescent:3})});
  w.HTMLElement.prototype.scrollIntoView = () => { pageJumps++; }; w.scrollBy = () => {}; w.scrollTo = () => {};
  w.postMessage = data => { if (!data?.type) return w.setTimeout(() => w.dispatchEvent(new w.MessageEvent('message', { source: w, data })), 0); messages.push(data); for (const [predicate, finish] of waiting) if (predicate(data)) { waiting.delete(predicate); finish(data); } };
  const waitFor = predicate => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { waiting.delete(predicate); reject(new Error('Frame response timeout: ' + JSON.stringify(messages))); }, 5000);
    waiting.set(predicate, data => { clearTimeout(timeout); resolve(data); });
  });
  const send = data => w.dispatchEvent(new w.MessageEvent('message', { source: w, data: { token: 'fixture', ...data } }));
  try {
    w.eval(bundle); assert.ok(messages.some(data => data?.type === 'ready'));
    const model = editing ? await openOfficeEditor(array(bytes), ext) : null;
    const loaded = waitFor(data => ['loaded', 'error'].includes(data.type));
    const frameBytes=new w.Uint8Array(bytes.length);frameBytes.set(bytes);
    send({ type: 'open', ext, buffer: frameBytes.buffer, blocks: model?.getBlocks(), viewMode: 'scroll' });
    const result = await loaded; assert.equal(result.type, 'loaded', result.message); assert.ok(result.pages >= 2);
    assert.ok(w.document.querySelector('section.docx,[data-slide-index]').textContent.length > 0);
    assert.equal(!!w.document.querySelector('.omni-edit-content'), editing);
    const zoomed = waitFor(data => data.requestId === 1); send({ type: 'zoom', zoom: 1.5, requestId: 1 });
    assert.equal((await zoomed).result, 1.5);
    if(ext==='docx')assert.match(w.document.querySelector('#doc-scale').style.transform, /scale\(/);
    else assert.equal(w.document.querySelector('#office').style.transform,'scale(1.5)');
    const scrolled = new w.WheelEvent('wheel', { deltaY: 25, bubbles: true, cancelable: true });
    w.document.querySelector('#office').dispatchEvent(scrolled); assert.equal(scrolled.defaultPrevented, false);
    const pinch = new w.WheelEvent('wheel', { ctrlKey: true, deltaY: -40, clientX: 100, clientY: 100, bubbles: true, cancelable: true });
    w.document.querySelector('#office').dispatchEvent(pinch);
    assert.equal(pinch.defaultPrevented, true); assert.equal(messages.at(-1).type, 'zoom-gesture'); assert.equal(messages.at(-1).delta, -40);
    const scaleKey = new w.KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: '+', code: 'Equal', bubbles: true, cancelable: true });
    w.document.querySelector('#office').dispatchEvent(scaleKey);
    assert.equal(scaleKey.defaultPrevented, true); assert.equal(messages.at(-1).type, 'shell-shortcut'); assert.equal(messages.at(-1).command, 'zoom-in');
    const content = w.document.querySelector(editing?'.omni-edit-content':'section.docx,[data-slide-index]');
    for(const [key,code,command] of [['ч','KeyX','theme'],['я','KeyZ','focus']]){
      const shortcut=new w.KeyboardEvent('keydown',{ctrlKey:true,key,code,bubbles:true,cancelable:true});content.dispatchEvent(shortcut);
      assert.equal(shortcut.defaultPrevented,true);assert.equal(messages.at(-1).type,'shell-shortcut');assert.equal(messages.at(-1).command,command);
    }
    if(editing){content.dispatchEvent(new w.KeyboardEvent('keydown',{ctrlKey:true,altKey:true,key:'z',code:'KeyZ',bubbles:true,cancelable:true}));assert.equal(messages.at(-1).type,'edit-shortcut');assert.equal(messages.at(-1).command,'undo');}
    for(const [code,command] of [['KeyD','toggle-edit'],['KeyE','highlight']]){
      const shortcut=new w.KeyboardEvent('keydown',{ctrlKey:true,code,bubbles:true,cancelable:true});content.dispatchEvent(shortcut);assert.equal(shortcut.defaultPrevented,true);assert.equal(messages.at(-1).command,command);
    }
    const synced=waitFor(data=>data.requestId===30);
    send({type:'shortcuts',bindings:{'toggle-edit':['Ctrl+Alt+KeyK'],highlight:['Ctrl+Alt+KeyH'],underline:['Ctrl+Alt+KeyU']}});send({type:'flush',requestId:30});await synced;
    const oldKey=new w.KeyboardEvent('keydown',{ctrlKey:true,code:'KeyD',bubbles:true,cancelable:true});content.dispatchEvent(oldKey);assert.equal(oldKey.defaultPrevented,false);
    const newKey=new w.KeyboardEvent('keydown',{ctrlKey:true,altKey:true,key:'л',code:'KeyK',bubbles:true,cancelable:true});content.dispatchEvent(newKey);assert.equal(newKey.defaultPrevented,true);assert.equal(messages.at(-1).command,'toggle-edit');
    const walker=w.document.createTreeWalker(content,w.NodeFilter.SHOW_TEXT);let selected;
    while(selected=walker.nextNode())if(selected.textContent.includes('OMNI'))break;
    assert.ok(selected);const range=w.document.createRange();range.setStart(selected,0);range.setEnd(selected,4);w.getSelection().removeAllRanges();w.getSelection().addRange(range);w.document.dispatchEvent(new w.Event('selectionchange'));
    if(editing){
      content.dispatchEvent(new w.KeyboardEvent('keydown',{ctrlKey:true,altKey:true,code:'KeyU',bubbles:true,cancelable:true}));assert.ok(content.querySelector('[data-underline="true"]'));
    }else{
      const marked=waitFor(data=>data.requestId===31);send({type:'highlight-add',color:'#ffe066',requestId:31});assert.equal((await marked).result[0].quote,'OMNI');assert.ok(content.querySelector('mark'));
      const found=waitFor(data=>data.requestId===32);send({type:'find',query:'OMNI '+ext.toUpperCase(),requestId:32});assert.equal((await found).result.page,1);
      if(ext==='docx')assert.equal(w.getSelection().toString(),'OMNI DOCX');
      const cleared=waitFor(data=>data.requestId===33);send({type:'highlight-clear',requestId:33});await cleared;assert.equal(content.querySelector('mark'),null);
    }
    assert.equal(touch(w, content, 'touchstart', [[1, 50, 100]]).defaultPrevented, false);
    assert.equal(touch(w, content, 'touchmove', [[1, 50, 110]]).defaultPrevented, false);
    assert.equal(touch(w, content, 'touchstart', [[1, 50, 100], [2, 150, 100]]).defaultPrevented, true);
    assert.equal(touch(w, content, 'touchmove', [[2, 200, 100], [1, 0, 100]]).defaultPrevented, true);
    const gesture = messages.at(-1);
    assert.equal(gesture.type, 'zoom-gesture'); assert.equal(gesture.token, 'fixture');
    assert.ok(Math.abs(Math.exp(-gesture.delta * 0.002) - 2) < 1e-10);
    assert.deepEqual(JSON.parse(JSON.stringify(gesture.anchor)), { x: 100, y: 100, from: { x: 100, y: 100 } });
    const touchedZoom = waitFor(data => data.requestId === 2);
    const beforePinch = pageJumps;const slide=ext==='pptx'?w.document.querySelector('[data-slide-index]'):null;
    send({ type: 'zoom', zoom: 1.5 * Math.exp(-gesture.delta * 0.002), anchor: gesture.anchor, requestId: 2 });
    assert.equal((await touchedZoom).result, 3);
    assert.equal(pageJumps, beforePinch, 'Zoom must not navigate back to the page top');
    if(slide)assert.equal(w.document.querySelector('[data-slide-index]'),slide,'Pinch must not rebuild the slide');
    if(ext==='docx'){
      const printed=waitFor(data=>data.requestId===901);send({type:'print-html',requestId:901});const html=(await printed).result;
      const printedDoc=new JSDOM(html);assert.ok(printedDoc.window.document.querySelectorAll('section.docx').length>=2);assert.match(printedDoc.window.document.body.textContent,/OMNI/);assert.equal(printedDoc.window.document.querySelector('script,iframe,object,[contenteditable]'),null);assert.equal(printedDoc.window.document.querySelector('#doc-scale').style.transform,'');printedDoc.window.close();
    }
    touch(w, content, 'touchend', []);
    w.dispatchEvent(new w.Event('pagehide'));
    assert.equal(touch(w, content, 'touchstart', [[1, 0, 0], [2, 100, 0]]).defaultPrevented, false);
    assert.ok(!messages.some(data => data.type === 'error'));
  } finally { w.dispatchEvent(new w.Event('pagehide')); w.close(); }
});

/** A scroll viewport with real boundary clamping and transform-aware geometry. */
function zoomFixture({ width = 360, height = 1200, center = false } = {}) {
  const w = new JSDOM('<div id="view"><article style="font-size:16px"><p>Unchanged lines and image</p></article></div>', { pretendToBeVisual: true }).window;
  const root = w.document.querySelector('#view'), content = root.firstElementChild, controller = new AbortController();
  let sx = 0, sy = 0;
  Object.defineProperties(root, {
    clientWidth: { value: 360 }, clientHeight: { value: 640 },
    scrollLeft: { get: () => sx, set: value => { sx = Math.max(0, Math.min(value, parseFloat(root.firstElementChild.style.width) - 360)); } },
    scrollTop: { get: () => sy, set: value => { sy = Math.max(0, Math.min(value, parseFloat(root.firstElementChild.style.height) - 640)); } }
  });
  root.getBoundingClientRect = () => ({ left: 10, top: 20, right: 370, bottom: 660, width: 360, height: 640 });
  Object.defineProperties(content, { offsetWidth: { get: () => width }, offsetHeight: { get: () => height }, scrollWidth: { get: () => width }, scrollHeight: { get: () => height } });
  const scale = () => Number(content.style.transform.match(/scale\(([^)]+)\)/)?.[1] || 1);
  content.getBoundingClientRect = () => {
    const left = 10 + (parseFloat(content.style.left) || 0) - sx, top = 20 + (parseFloat(content.style.top) || 0) - sy;
    return { left, top, width: width * scale(), height: height * scale(), right: left + width * scale(), bottom: top + height * scale() };
  };
  const visual = createVisualZoom(root, content, { signal: controller.signal, center, fixedWidth: !center });
  const local = point => { const rect = content.getBoundingClientRect(); return { x: (10 + point.x - rect.left) / scale(), y: (20 + point.y - rect.top) / scale() }; };
  const assertUnder = (original, point) => {
    const rect = content.getBoundingClientRect();
    assert.ok(Math.abs(rect.left + original.x * scale() - 10 - point.x) < 1e-8, 'Horizontal focal point moved');
    assert.ok(Math.abs(rect.top + original.y * scale() - 20 - point.y) < 1e-8, 'Vertical focal point moved');
  };
  return { w, root, content, visual, local, assertUnder, close() { controller.abort(); w.close(); } };
}

test('Optical zoom preserves line layout and focal points at all scroll boundaries', () => {
  for (const point of [{ x: 8, y: 18 }, { x: 350, y: 620 }, { x: 180, y: 300 }]) {
    const f = zoomFixture(), original = f.local(point), markup = f.content.innerHTML;
    try {
      for (const zoom of [3, 0.5, 1, 2, 1]) {
        f.visual.setZoom(zoom, point);f.assertUnder(original, point);
        f.visual.refresh();f.assertUnder(original, point);
        assert.equal(f.content.style.width, '360px');assert.equal(f.content.style.fontSize, '16px');
        assert.equal(f.content.innerHTML, markup);
      }
    } finally { f.close(); }
  }
});

test('A fitted letterboxed image zooms around the touched region and follows both fingers', () => {
  const f = zoomFixture({ width: 360, height: 240, center: true });
  const start = { x: 35, y: 240 }, original = f.local(start), destination = { x: 90, y: 270 };
  try {
    assert.equal(f.content.getBoundingClientRect().top, 220);
    f.visual.setZoom(1.5, { ...destination, from: start });f.assertUnder(original, destination);
    f.visual.setZoom(3, destination);f.assertUnder(original, destination);
    f.visual.setZoom(0.5, destination);f.assertUnder(original, destination);
    f.visual.refresh();f.assertUnder(original, destination);
  } finally { f.close(); }
});

test('Queued moving-finger gestures retain their first source point through async rendering', async () => {
  const f = zoomFixture(), values = [], before = Object.getOwnPropertyDescriptors(globalThis);
  globalThis.requestAnimationFrame = f.w.requestAnimationFrame.bind(f.w);globalThis.cancelAnimationFrame = f.w.cancelAnimationFrame.bind(f.w);
  let release;
  const gestures = bindZoomGestures(f.root, { getZoom: () => f.visual.zoom, async setZoom(value, anchor) {
    values.push({ value, anchor });await new Promise(resolve => { release = resolve; });f.visual.setZoom(value, anchor);
  } });
  const frame = () => new Promise(resolve => f.w.requestAnimationFrame(resolve));
  const original = f.local({ x: 60, y: 100 });
  try {
    touch(f.w, f.root, 'touchstart', [[1, 30, 120], [2, 110, 120]]);
    touch(f.w, f.root, 'touchmove', [[1, 30, 120], [2, 150, 120]]);
    touch(f.w, f.root, 'touchmove', [[1, 30, 120], [2, 190, 120]]);
    await frame();assert.ok(Math.abs(values[0].value - 2) < 1e-10);
    assert.deepEqual(values[0].anchor, { x: 100, y: 100, from: { x: 60, y: 100 } });
    touch(f.w, f.root, 'touchmove', [[1, 30, 120], [2, 210, 120]]);
    touch(f.w, f.root, 'touchmove', [[1, 30, 120], [2, 250, 120]]);
    release();await frame();f.assertUnder(original, { x: 100, y: 100 });
    assert.equal(values.length, 2);assert.deepEqual(values[1].anchor.from, { x: 100, y: 100 });
    release();await frame();f.assertUnder(original, { x: 130, y: 100 });
  } finally {
    release?.();gestures.dispose();f.close();
    for (const name of ['requestAnimationFrame', 'cancelAnimationFrame']) { if (before[name]) Object.defineProperty(globalThis, name, before[name]);else delete globalThis[name]; }
  }
});

test('Zoom in a page gap anchors to the nearest visible page instead of jumping to its top', () => {
  const root = { scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  let rect = { left: 0, top: 120, width: 300, height: 400, right: 300, bottom: 520 };
  const page = { getBoundingClientRect: () => rect };
  const restore = captureZoomAnchor(() => [page], root, { x: 60, y: 100 });
  rect = { left: 0, top: 240, width: 600, height: 800, right: 600, bottom: 1040 };restore();
  assert.equal(root.scrollLeft, 60);assert.equal(root.scrollTop, 100);
});
test('Finger pinch preserves single-finger scrolling, resets changed fingers and cleans up', () => {
  const w = new JSDOM('<div id="view"></div>').window;
  const root = w.document.querySelector('#view'), controller = new AbortController(), changes = [];
  root.getBoundingClientRect = () => ({ left: 10, top: 20 });
  const dispose = bindTouchPinch(root, (delta, anchor) => changes.push({ factor: Math.exp(-delta * 0.002), anchor }), { signal: controller.signal });
  const fire = (type, points) => touch(w, root, type, points);
  try {
    assert.equal(fire('touchstart', [[1, 20, 30]]).defaultPrevented, false);
    assert.equal(fire('touchmove', [[1, 20, 40]]).defaultPrevented, false);
    assert.equal(changes.length, 0);
    fire('touchstart', [[1, 20, 40], [2, 120, 40]]);
    fire('touchmove', [[2, 170, 40], [1, 20, 40]]);
    assert.equal(changes[0].factor, 1.5); assert.deepEqual(changes[0].anchor, { x: 85, y: 20, from: { x: 60, y: 20 } });
    fire('touchmove', [[1, 20, 40], [2, 95, 40]]);
    assert.equal(changes[1].factor, 0.5);
    fire('touchend', [[1, 20, 40]]);
    assert.equal(fire('touchmove', [[1, 20, 50]]).defaultPrevented, true);
    fire('touchstart', [[1, 20, 50], [3, 220, 50]]);
    assert.equal(changes.length, 2);
    fire('touchmove', [[3, 120, 50], [1, 20, 50]]);
    assert.equal(changes[2].factor, 0.5);
    fire('touchcancel', []);
    assert.equal(fire('touchmove', [[1, 20, 60]]).defaultPrevented, false);
    fire('touchstart', [[1, 20, 60], [3, 20, 60]]);
    fire('touchmove', [[1, 20, 60], [3, 120, 60]]);
    assert.equal(changes.length, 3); // Coincident fingers establish a fresh baseline.
    controller.abort();
    assert.equal(fire('touchmove', [[1, 20, 60], [3, 220, 60]]).defaultPrevented, false);
    assert.equal(changes.length, 3);
  } finally { dispose(); w.close(); }
});
test('Finger gestures reach the shared zoom controller and coalesce while it renders', async () => {
  const w = new JSDOM('<div id="view"></div>', { pretendToBeVisual: true }).window;
  globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w); globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  const root = w.document.querySelector('#view'), values = [];
  let zoom = 1, release;
  const gestures = bindZoomGestures(root, { getZoom: () => zoom, async setZoom(value) {
    values.push(value); await new Promise(resolve => { release = resolve; }); zoom = value;
  } });
  const frame = () => new Promise(resolve => w.requestAnimationFrame(resolve));
  try {
    touch(w, root, 'touchstart', [[1, 0, 0], [2, 100, 0]]);
    touch(w, root, 'touchmove', [[1, 0, 0], [2, 150, 0]]);
    await frame(); assert.equal(values[0], 1.5);
    touch(w, root, 'touchmove', [[1, 0, 0], [2, 200, 0]]);
    touch(w, root, 'touchmove', [[1, 0, 0], [2, 250, 0]]);
    assert.equal(values.length, 1);
    release(); await frame(); assert.ok(Math.abs(values[1] - 2.5) < 1e-10);
    release(); await frame();
    touch(w, root, 'touchmove', [[1, 0, 0], [2, 500, 0]]);
    await frame(); assert.equal(values[2], 3); release(); await frame();
    gestures.dispose();
    assert.equal(touch(w, root, 'touchmove', [[1, 0, 0], [2, 100, 0]]).defaultPrevented, false);
  } finally { release?.(); gestures.dispose(); w.close(); }
});
test('Touchpad preserves native scrolling and coalesces pinch events during rendering', async () => {
  const w = new JSDOM('<div id="view"></div>', { pretendToBeVisual: true }).window;
  globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w); globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  const root = w.document.querySelector('#view'), controller = new AbortController();
  let zoom = 1, active = 0, maxActive = 0; const values = [];
  const gestures = bindZoomGestures(root, { signal: controller.signal, getZoom: () => zoom, async setZoom(value) {
    active++; maxActive = Math.max(maxActive, active); values.push(value);
    await new Promise(resolve => setTimeout(resolve, 30)); zoom = value; active--;
  } });
  const wheel = (deltaY, ctrlKey = true) => { const event = new w.WheelEvent('wheel', { deltaY, ctrlKey, cancelable: true }); root.dispatchEvent(event); return event; };
  try {
    assert.equal(wheel(30, false).defaultPrevented, false); assert.equal(values.length, 0);
    wheel(-50); wheel(-50); await new Promise(resolve => setTimeout(resolve, 22));
    wheel(-50); wheel(-50); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(maxActive, 1); assert.equal(values.length, 2); assert.ok(Math.abs(zoom - Math.exp(0.4)) < 1e-10);
    wheel(600); await new Promise(resolve => setTimeout(resolve, 70)); assert.equal(zoom, 0.5);
    controller.abort(); assert.equal(wheel(-100).defaultPrevented, false);
  } finally { gestures.dispose(); w.close(); }
});
