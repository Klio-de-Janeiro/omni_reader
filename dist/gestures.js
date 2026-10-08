/** Precision touchpads report pinch as Ctrl+wheel. Ordinary wheel events stay native. */
export function wheelZoomDelta(event) {
  if (!event.ctrlKey || !Number.isFinite(event.deltaY)) return null;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 600 : 1;
  return Math.max(-600, Math.min(600, event.deltaY * unit));
}

/** Convert two-finger touch gestures to the same document zoom used by touchpads. */
export function bindTouchPinch(root, zoomBy, { signal } = {}) {
  let previous = null, pinching = false, disposed = false;
  const prevent = event => {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  };
  function touch(event) {
    if (disposed) return;
    const touches = [...event.touches];
    if (touches.length !== 2) {
      previous = null;
      if (pinching) prevent(event);
      if (!touches.length) pinching = false;
      return;
    }
    pinching = true; prevent(event);
    const [a, b] = touches;
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!Number.isFinite(distance) || distance < 1) { previous = null; return; }
    const samePair = previous && [a.identifier, b.identifier].every(id => previous.ids.includes(id));
    const rect = root.window === root ? { left: 0, top: 0 } : root.getBoundingClientRect();
    const center = { x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top };
    if (event.type === 'touchmove' && samePair) {
      zoomBy(-Math.log(distance / previous.distance) / 0.002, {
        ...center, from: previous.center
      });
    }
    previous = { ids: [a.identifier, b.identifier], distance, center };
    if (event.type === 'touchcancel') previous = null;
  }
  const events = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
  function dispose() {
    disposed = true; previous = null; pinching = false;
    for (const type of events) root.removeEventListener(type, touch, true);
    signal?.removeEventListener('abort', dispose);
  }
  for (const type of events) root.addEventListener(type, touch, { passive: false, capture: true });
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  return dispose;
}

/** Keep the point inside a page under the fingers after its size changes. */
const scrollSpaces = new WeakMap();
const isWindow = root => root.window === root;
const viewportSize = root => {
  if(isWindow(root))return {x:0,y:0,width:root.document.documentElement.clientWidth || root.innerWidth,height:root.innerHeight};
  const css=root.ownerDocument.defaultView.getComputedStyle(root);
  const x=parseFloat(css.paddingLeft) || 0,y=parseFloat(css.paddingTop) || 0;
  return {x,y,width:root.clientWidth-x-(parseFloat(css.paddingRight) || 0),height:root.clientHeight-y-(parseFloat(css.paddingBottom) || 0)};
};

/** Allow an anchored point to stay put even at the native scroll boundaries. */
export function createZoomSpace(root, content, { signal, center = false } = {}) {
  const stage = content.ownerDocument.createElement('div'); stage.className = 'zoom-space';
  stage.style.cssText = 'position:relative;display:flow-root;min-width:100%;min-height:100%;';
  content.replaceWith(stage); stage.append(content);
  content.style.position = 'relative';
  let x = 0, y = 0, left = 0, top = 0, width = 0, height = 0;
  const scroller = isWindow(root) ? root.document.scrollingElement || root.document.documentElement : root;
  const anchoring = scroller.style.overflowAnchor; scroller.style.overflowAnchor = 'none';
  function refresh(extraWidth = 0, extraHeight = 0) {
    const viewport = viewportSize(root), rect = content.getBoundingClientRect();
    const scale = content.offsetWidth ? rect.width / content.offsetWidth : 1;
    width = Math.max(rect.width || content.offsetWidth, center ? 0 : (content.scrollWidth || 0) * scale);
    height = Math.max(rect.height || content.offsetHeight, center ? 0 : (content.scrollHeight || 0) * scale);
    left = x + (center ? Math.max(0, (viewport.width - width) / 2) : 0);
    top = y + (center ? Math.max(0, (viewport.height - height) / 2) : 0);
    content.style.left = left + 'px'; content.style.top = top + 'px';
    const sx = isWindow(root) ? root.scrollX : root.scrollLeft, sy = isWindow(root) ? root.scrollY : root.scrollTop;
    stage.style.width = Math.max(viewport.width, left + width, extraWidth, sx + viewport.width) + 'px';
    stage.style.height = Math.max(viewport.height, top + height, extraHeight, sy + viewport.height) + 'px';
  }
  function restore(dx, dy) {
    let sx = (isWindow(root) ? root.scrollX : root.scrollLeft) + dx;
    let sy = (isWindow(root) ? root.scrollY : root.scrollTop) + dy;
    if (sx < 0) { x -= sx; sx = 0; }
    if (sy < 0) { y -= sy; sy = 0; }
    const viewport = viewportSize(root);
    refresh(sx + viewport.width, sy + viewport.height);
    if (isWindow(root)) root.scrollTo(sx, sy);
    else { root.scrollLeft = sx; root.scrollTop = sy; }
  }
  const api = { stage, refresh, restore };
  scrollSpaces.set(root, api); refresh();
  signal?.addEventListener('abort', () => {
    if (scrollSpaces.get(root) === api) { scrollSpaces.delete(root); scroller.style.overflowAnchor = anchoring; }
  }, { once: true });
  return api;
}

/** Magnify an unchanged layout, rather than changing fonts and wrapping its lines. */
export function createVisualZoom(root, content, { signal, center = false, fixedWidth = true, fillHeight = false } = {}) {
  let zoom = 1;
  function size() {
    if (!fixedWidth) return;
    const viewport = viewportSize(root);
    content.style.width = Math.max(1, viewport.width) + 'px';
    content.style.minHeight = Math.max(1, viewport.height) + 'px';
    if (fillHeight) content.style.height = content.style.minHeight;
  }
  size(); content.style.transformOrigin = '0 0';
  const space = createZoomSpace(root, content, { signal, center });
  let bounds = root.getBoundingClientRect();
  function setZoom(value, point) {
    const viewport = viewportSize(root);
    const restore = captureZoomAnchor(() => [content], root, point || { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 });
    zoom = value; content.style.transform = `scale(${zoom})`; space.refresh(); restore();
  }
  const Observer = content.ownerDocument.defaultView.ResizeObserver || globalThis.ResizeObserver;
  const observer = Observer && new Observer(entries => {
    const next = root.getBoundingClientRect();
    if (entries.some(entry => entry.target === root) && (next.width !== bounds.width || next.height !== bounds.height)) { size(); bounds = next; }
    space.refresh();
  });
  observer?.observe(content); observer?.observe(root);
  signal?.addEventListener('abort', () => observer?.disconnect(), { once: true });
  return { setZoom, refresh: () => space.refresh(), get zoom() { return zoom; } };
}

export function captureZoomAnchor(getElements, root, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return () => {};
  const frame = isWindow(root) ? { left: 0, top: 0 } : root.getBoundingClientRect();
  const source = point.from || point;
  const x = frame.left + source.x, y = frame.top + source.y, elements = getElements();
  let index = -1, distance = Infinity;
  elements.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (el.hidden || !rect.width || !rect.height) return;
    const gap = Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
    if (gap < distance) { distance = gap; index = i; }
  });
  if (index < 0) return () => {};
  const rect = elements[index].getBoundingClientRect();
  if (!rect.width) return () => {};
  const rx = (x - rect.left) / rect.width, ry = (y - rect.top) / rect.height;
  return () => {
    const element = getElements()[index]; if (!element || element.hidden) return;
    const next = element.getBoundingClientRect();
    const dx = next.left + rx * next.width - frame.left - point.x, dy = next.top + ry * next.height - frame.top - point.y;
    const space = scrollSpaces.get(root);
    if (space) space.restore(dx, dy);
    else if (isWindow(root)) root.scrollBy(dx, dy);
    else { root.scrollLeft += dx; root.scrollTop += dy; }
  };
}

/** Coalesce a gesture stream while an expensive document render is in flight. */
export function bindZoomGestures(root, { getZoom, setZoom, signal, onError }) {
  let wanted = null, anchor, frame = 0, running = false, disposed = false;
  const schedule = () => {
    if (!frame && !running && !disposed) frame = requestAnimationFrame(apply);
  };
  async function apply() {
    frame = 0; if (disposed || wanted === null) return;
    const value = wanted, point = anchor; wanted = null; anchor = null; running = true;
    try { await setZoom(value, point); }
    catch (error) { if (!disposed) onError?.(error); }
    finally { running = false; if (wanted !== null) schedule(); }
  }
  let requested;
  function zoomBy(delta, point) {
    if (disposed || !Number.isFinite(delta)) return;
    const start = wanted ?? (running ? requested : getZoom());
    wanted = Math.max(0.5, Math.min(3, start * Math.exp(-delta * 0.002)));
    requested = wanted;
    anchor = point?.from && anchor?.from ? { ...point, from: anchor.from } : point;
    schedule();
  }
  const wheel = event => {
    const delta = wheelZoomDelta(event); if (delta === null) return;
    event.preventDefault();event.stopPropagation();
    const rect = root.getBoundingClientRect();
    zoomBy(delta, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };
  const disposeTouch = bindTouchPinch(root, zoomBy);
  function dispose() {
    disposed = true; cancelAnimationFrame(frame); root.removeEventListener('wheel', wheel, true);
    disposeTouch(); signal?.removeEventListener('abort', dispose);
  }
  root.addEventListener('wheel', wheel, { passive: false, capture: true });
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  return { zoomBy, dispose };
}
