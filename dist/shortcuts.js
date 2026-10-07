/** Match the fullscreen keys independently of the current keyboard layout. */
export function isFullscreenShortcut(event) {
  const key = event.key?.toLowerCase();
  return !!(!event.altKey && (
    event.ctrlKey && !event.shiftKey && (event.code === 'KeyZ' || key === 'z') ||
    (event.ctrlKey || event.metaKey) && event.shiftKey && (event.code === 'KeyF' || key === 'f')
  ));
}

export function isThemeShortcut(event) {
  return !!(event.ctrlKey && !event.altKey && !event.shiftKey && (event.code === 'KeyX' || event.key?.toLowerCase() === 'x'));
}

/** Keep undo/redo available after Ctrl+Z becomes the fullscreen shortcut. */
export function editingShortcut(event) {
  const key = event.code || 'Key' + event.key?.toUpperCase();
  if (!(event.ctrlKey || event.metaKey)) return null;
  if (key === 'KeyZ' && !event.shiftKey && (event.ctrlKey && event.altKey || event.metaKey && !event.ctrlKey && !event.altKey)) return 'undo';
  if (event.altKey) return null;
  if (key === 'KeyY' || key === 'KeyZ' && event.shiftKey) return 'redo';
  if (key === 'KeyS') return 'save';
  return null;
}

/** Match both the main keyboard and numpad without relying on keyboard layout. */
export function zoomShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (['+', '='].includes(event.key) || ['Equal', 'NumpadAdd'].includes(event.code)) return 'zoom-in';
  if (event.key === '-' || ['Minus', 'NumpadSubtract'].includes(event.code)) return 'zoom-out';
  if (event.key === '0' || ['Digit0', 'Numpad0'].includes(event.code)) return 'zoom-reset';
  return null;
}
