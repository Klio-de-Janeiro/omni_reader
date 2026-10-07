import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { openOfficeEditor } from '../dist/vendor/editors.js';
import { bindZoomGestures, bindTouchPinch } from '../dist/gestures.js';
const fixture = await readFile(new URL('./fixtures/sample.docx', import.meta.url));
const array = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const bundle = await readFile(new URL('../dist/vendor/office.js', import.meta.url), 'utf8');
function touch(w, target, type, points) {
  const event = new w.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: points.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })) });
  target.dispatchEvent(event); return event;
}
for (const editing of [false, true]) test('Bundled DOCX entry opens and zooms: ' + (editing ? 'inline editor' : 'viewer'), async () => {
  const dom = new JSDOM('<!doctype html><div id="office"></div>', { pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window, messages = [], waiting = new Map();
  Object.assign(w, { TextEncoder, TextDecoder, structuredClone, ResizeObserver: class { observe() {} disconnect() {} } });
  w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollBy = () => {};
  w.postMessage = data => { if (!data?.type) return w.setTimeout(() => w.dispatchEvent(new w.MessageEvent('message', { source: w, data })), 0); messages.push(data); for (const [predicate, finish] of waiting) if (predicate(data)) { waiting.delete(predicate); finish(data); } };
  const waitFor = predicate => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { waiting.delete(predicate); reject(new Error('Frame response timeout: ' + JSON.stringify(messages))); }, 5000);
    waiting.set(predicate, data => { clearTimeout(timeout); resolve(data); });
  });
  const send = data => w.dispatchEvent(new w.MessageEvent('message', { source: w, data: { token: 'fixture', ...data } }));
  try {
    w.eval(bundle); assert.ok(messages.some(data => data?.type === 'ready'));
    const model = editing ? await openOfficeEditor(array(fixture), 'docx') : null;
    const loaded = waitFor(data => ['loaded', 'error'].includes(data.type));
    send({ type: 'open', ext: 'docx', buffer: array(fixture), blocks: model?.getBlocks(), viewMode: 'scroll' });
    const result = await loaded; assert.equal(result.type, 'loaded', result.message); assert.ok(result.pages >= 2);
    assert.ok(w.document.querySelector('section.docx').textContent.length > 0);
    assert.equal(!!w.document.querySelector('.omni-edit-content'), editing);
    const zoomed = waitFor(data => data.requestId === 1); send({ type: 'zoom', zoom: 1.5, requestId: 1 });
    assert.equal((await zoomed).result, 1.5); assert.match(w.document.querySelector('#doc-scale').style.transform, /scale\(/);
    const scrolled = new w.WheelEvent('wheel', { deltaY: 25, bubbles: true, cancelable: true });
    w.document.querySelector('#office').dispatchEvent(scrolled); assert.equal(scrolled.defaultPrevented, false);
    const pinch = new w.WheelEvent('wheel', { ctrlKey: true, deltaY: -40, clientX: 100, clientY: 100, bubbles: true, cancelable: true });
    w.document.querySelector('#office').dispatchEvent(pinch);
    assert.equal(pinch.defaultPrevented, true); assert.equal(messages.at(-1).type, 'zoom-gesture'); assert.equal(messages.at(-1).delta, -40);
    const scaleKey = new w.KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: '+', code: 'Equal', bubbles: true, cancelable: true });
    w.document.querySelector('#office').dispatchEvent(scaleKey);
    assert.equal(scaleKey.defaultPrevented, true); assert.equal(messages.at(-1).type, 'shell-shortcut'); assert.equal(messages.at(-1).command, 'zoom-in');
    const content = w.document.querySelector(editing?'.omni-edit-content':'section.docx');
    for(const [key,code,command] of [['ч','KeyX','theme'],['я','KeyZ','focus']]){
      const shortcut=new w.KeyboardEvent('keydown',{ctrlKey:true,key,code,bubbles:true,cancelable:true});content.dispatchEvent(shortcut);
      assert.equal(shortcut.defaultPrevented,true);assert.equal(messages.at(-1).type,'shell-shortcut');assert.equal(messages.at(-1).command,command);
    }
    if(editing){content.dispatchEvent(new w.KeyboardEvent('keydown',{ctrlKey:true,altKey:true,key:'z',code:'KeyZ',bubbles:true,cancelable:true}));assert.equal(messages.at(-1).type,'edit-shortcut');assert.equal(messages.at(-1).command,'undo');}
    assert.equal(touch(w, content, 'touchstart', [[1, 50, 100]]).defaultPrevented, false);
    assert.equal(touch(w, content, 'touchmove', [[1, 50, 110]]).defaultPrevented, false);
    assert.equal(touch(w, content, 'touchstart', [[1, 50, 100], [2, 150, 100]]).defaultPrevented, true);
    assert.equal(touch(w, content, 'touchmove', [[2, 200, 100], [1, 0, 100]]).defaultPrevented, true);
    const gesture = messages.at(-1);
    assert.equal(gesture.type, 'zoom-gesture'); assert.equal(gesture.token, 'fixture');
    assert.ok(Math.abs(Math.exp(-gesture.delta * 0.002) - 2) < 1e-10);
    assert.deepEqual(JSON.parse(JSON.stringify(gesture.anchor)), { x: 100, y: 100 });
    const touchedZoom = waitFor(data => data.requestId === 2);
    send({ type: 'zoom', zoom: 1.5 * Math.exp(-gesture.delta * 0.002), anchor: gesture.anchor, requestId: 2 });
    assert.equal((await touchedZoom).result, 3);
    touch(w, content, 'touchend', []);
    w.dispatchEvent(new w.Event('pagehide'));
    assert.equal(touch(w, content, 'touchstart', [[1, 0, 0], [2, 100, 0]]).defaultPrevented, false);
    assert.ok(!messages.some(data => data.type === 'error'));
  } finally { w.dispatchEvent(new w.Event('pagehide')); w.close(); }
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
    assert.equal(changes[0].factor, 1.5); assert.deepEqual(changes[0].anchor, { x: 85, y: 20 });
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
