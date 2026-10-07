const clamp = (value, max) => Math.max(0, Math.min(max, Number(value) || 0));

/** Convert hue, saturation and brightness to an opaque sRGB hex color. */
export function hsvToHex(hue, saturation, brightness) {
  const h = ((Number(hue) || 0) % 360 + 360) % 360 / 60, s = clamp(saturation, 100) / 100, v = clamp(brightness, 100) / 100;
  const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c;
  const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h)];
  return '#' + rgb.map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('');
}

/** Convert a six-digit hex color to hue, saturation and brightness percentages. */
export function hexToHsv(hex) {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error('Укажите цвет в формате #RRGGBB.');
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  if (delta) hue = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: (hue * 60 + 360) % 360, saturation: max ? delta / max * 100 : 0, brightness: max * 100 };
}
