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
    if (event.type === 'touchmove' && samePair) {
      const rect = root.window === root ? { left: 0, top: 0 } : root.getBoundingClientRect();
      zoomBy(-Math.log(distance / previous.distance) / 0.002, {
        x: (a.clientX + b.clientX) / 2 - rect.left,
        y: (a.clientY + b.clientY) / 2 - rect.top
      });
    }
    previous = { ids: [a.identifier, b.identifier], distance };
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
export function captureZoomAnchor(getElements, root, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return () => {};
  const frame = root === window ? { left: 0, top: 0 } : root.getBoundingClientRect();
  const x = frame.left + point.x, y = frame.top + point.y, elements = getElements();
  const index = elements.findIndex(el => {
    const rect = el.getBoundingClientRect();
    return !el.hidden && rect.height > 0 && rect.top <= y && rect.bottom >= y;
  });
  if (index < 0) return () => {};
  const rect = elements[index].getBoundingClientRect();
  if (!rect.width) return () => {};
  const rx = (x - rect.left) / rect.width, ry = (y - rect.top) / rect.height;
  return () => {
    const element = getElements()[index]; if (!element || element.hidden) return;
    const next = element.getBoundingClientRect();
    const dx = next.left + rx * next.width - x, dy = next.top + ry * next.height - y;
    if (root === window) root.scrollBy(dx, dy);
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
    const value = wanted, point = anchor; wanted = null; running = true;
    try { await setZoom(value, point); }
    catch (error) { if (!disposed) onError?.(error); }
    finally { running = false; if (wanted !== null) schedule(); }
  }
  let requested;
  function zoomBy(delta, point) {
    if (disposed || !Number.isFinite(delta)) return;
    const start = wanted ?? (running ? requested : getZoom());
    wanted = Math.max(0.5, Math.min(3, start * Math.exp(-delta * 0.002)));
    requested = wanted; anchor = point; schedule();
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
