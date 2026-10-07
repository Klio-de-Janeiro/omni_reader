import { hsvToHex } from './colors.js';

export const THEME_DEFAULTS = { mode: 'neon', hue: 200, saturation: 70, brightness: 3, glow: true, intensity: 35, gradients: false, borders: true, radius: 8 };
const modes = ['normal', 'system', 'neon'], key = 'omni.theme.v1';
const ranges = { hue: [0, 360], saturation: [0, 100], brightness: [0, 18], intensity: [0, 100], radius: [0, 24] };
/** Validate persisted values before using them in CSS or the settings controls. */
export function themeSettings(input = {}) {
  const result = { ...THEME_DEFAULTS, mode: modes.includes(input?.mode) ? input.mode : THEME_DEFAULTS.mode };
  for (const [name, [min, max]] of Object.entries(ranges)) if (Number.isFinite(input?.[name])) result[name] = Math.max(min, Math.min(max, input[name]));
  for (const name of ['glow', 'gradients', 'borders']) if (typeof input?.[name] === 'boolean') result[name] = input[name];
  return result;
}

/** Apply three local themes, react to OS changes and persist neon preferences. */
export function initThemes(document) {
  const window = document.defaultView, root = document.documentElement, get = id => document.getElementById(id);
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  function systemDark(){
    if(window.navigator.userAgent.includes('OmniAndroid')){
      try{const result=JSON.parse(window.prompt('OMNI_NATIVE',JSON.stringify({action:'system-theme'})));if(typeof result?.dark==='boolean')return result.dark;}catch{}
    }
    return !!media?.matches;
  }
  let settings;
  try { settings = themeSettings(JSON.parse(window.localStorage.getItem(key) || '{}')); } catch { settings = themeSettings(); }
  function apply(save = true) {
    const dark = settings.mode === 'neon' || settings.mode === 'system' && systemDark();
    const h = settings.hue, s = settings.saturation, v = settings.brightness;
    const palette = settings.mode === 'neon' ? {
      bg: hsvToHex(h, s * .35, v), surface: hsvToHex(h, s * .25, v + 3), raised: hsvToHex(h, s * .35, v + 7),
      control: hsvToHex(h, s * .4, v + 10), text: '#edf1f8', muted: '#a8b3c4', accent: hsvToHex(h, s, 100), line: hsvToHex(h, s * .65, v + 25)
    } : dark ? { bg: '#090909', surface: '#111111', raised: '#1a1a1a', control: '#242424', text: '#ececec', muted: '#aaaaaa', accent: '#42b9d9', line: '#343434' }
      : { bg: '#f5f6fb', surface: '#ffffff', raised: '#eef1f7', control: '#edf0f7', text: '#20233f', muted: '#616982', accent: '#5551eb', line: '#d4d9e4' };
    root.dataset.theme = settings.mode; root.dataset.themeDark = String(dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
    for (const [name, value] of Object.entries(palette)) root.style.setProperty('--theme-' + name, value);
    const neon = settings.mode === 'neon', glow = neon && settings.glow ? settings.intensity / 100 : 0;
    root.style.setProperty('--theme-glow', glow ? `0 0 ${Math.round(4 + glow * 30)}px ${palette.accent}${Math.round(glow * 130).toString(16).padStart(2, '0')}` : 'none');
    root.style.setProperty('--theme-gradient', neon && settings.gradients ? `radial-gradient(ellipse at 75% 0,${palette.raised},transparent 60%)` : 'none');
    root.style.setProperty('--theme-border', neon && !settings.borders ? 'transparent' : palette.line);
    root.style.setProperty('--theme-radius', (neon ? settings.radius : 10) + 'px');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.bg);
    if (get('theme-mode')) get('theme-mode').value = settings.mode;
    if (get('theme-dialog-mode')) get('theme-dialog-mode').value = settings.mode;
    for (const name of Object.keys(ranges)) {
      const input = get('theme-' + name); if (input) input.value = settings[name];
      const output = get('theme-' + name + '-value'); if (output) output.value = settings[name];
    }
    for (const name of ['glow', 'gradients', 'borders']) if (get('theme-' + name)) get('theme-' + name).checked = settings[name];
    if (get('theme-neon-options')) get('theme-neon-options').disabled = !neon;
    if (save) try { window.localStorage.setItem(key, JSON.stringify(settings)); } catch { /* Themes still work when persistence is unavailable. */ }
    window.dispatchEvent(new window.CustomEvent('omni-theme-change', { detail: { background: palette.bg, dark } }));
  }
  const setMode = mode => { settings = themeSettings({ ...settings, mode }); apply(); };
  for (const id of ['theme-mode', 'theme-dialog-mode']) if (get(id)) get(id).onchange = event => setMode(event.target.value);
  for (const name of Object.keys(ranges)) if (get('theme-' + name)) get('theme-' + name).oninput = event => { settings = themeSettings({ ...settings, [name]: Number(event.target.value) }); apply(); };
  for (const name of ['glow', 'gradients', 'borders']) if (get('theme-' + name)) get('theme-' + name).onchange = event => { settings[name] = event.target.checked; apply(); };
  if (get('theme-settings')) get('theme-settings').onclick = () => get('theme-dialog').showModal();
  if (get('theme-close')) get('theme-close').onclick = () => get('theme-dialog').close();
  if (get('theme-reset')) get('theme-reset').onclick = () => { settings = { ...THEME_DEFAULTS }; apply(); };
  media?.addEventListener?.('change', () => { if (settings.mode === 'system') apply(false); });
  window.addEventListener('omni-system-theme',()=>{if(settings.mode==='system')apply(false);});
  apply(false);
  return { cycle() { setMode(modes[(modes.indexOf(settings.mode) + 1) % modes.length]); }, get settings() { return { ...settings }; } };
}

/** Office iframe backgrounds share the host theme while document colors stay intact. */
export function documentTheme(document) {
  return { background: document.documentElement.style.getPropertyValue('--theme-bg') || '#020611', dark: document.documentElement.dataset.themeDark !== 'false' };
}
