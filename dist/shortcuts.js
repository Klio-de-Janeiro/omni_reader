export const SHORTCUT_STORAGE = 'omni.shortcuts.v1';
export const SHORTCUTS = [
  { id:'toggle-edit', label:'Просмотр / редактирование', keys:['Ctrl+KeyD','Meta+KeyD'] },
  { id:'highlight', label:'Временный цветной маркер', keys:['Ctrl+KeyE','Meta+KeyE'] },
  { id:'focus', label:'Полноэкранный режим', keys:['Ctrl+KeyZ','Ctrl+Shift+KeyF','Meta+Shift+KeyF'] },
  { id:'theme', label:'Следующая тема', keys:['Ctrl+KeyX'] },
  { id:'escape', label:'Выйти из полного экрана / закрыть просмотр', keys:['Escape'] },
  { id:'zoom-in', label:'Увеличить масштаб', keys:['Ctrl+Equal','Ctrl+Shift+Equal','Ctrl+NumpadAdd','Meta+Equal','Meta+Shift+Equal','Meta+NumpadAdd'] },
  { id:'zoom-out', label:'Уменьшить масштаб', keys:['Ctrl+Minus','Ctrl+NumpadSubtract','Meta+Minus','Meta+NumpadSubtract'] },
  { id:'zoom-reset', label:'Масштаб 100%', keys:['Ctrl+Digit0','Ctrl+Numpad0','Meta+Digit0','Meta+Numpad0'] },
  { id:'save', label:'Сохранить копию', keys:['Ctrl+KeyS','Meta+KeyS'] },
  { id:'undo', label:'Отменить правку', keys:['Ctrl+Alt+KeyZ','Meta+KeyZ'] },
  { id:'redo', label:'Повторить правку', keys:['Ctrl+KeyY','Ctrl+Shift+KeyZ','Meta+KeyY','Meta+Shift+KeyZ'] },
  { id:'bold', label:'Жирный текст DOCX/PPTX', keys:['Ctrl+KeyB','Meta+KeyB'] },
  { id:'italic', label:'Курсив DOCX/PPTX', keys:['Ctrl+KeyI','Meta+KeyI'] },
  { id:'underline', label:'Подчёркивание DOCX/PPTX', keys:['Ctrl+KeyU','Meta+KeyU'] },
  { id:'strike', label:'Зачёркивание DOCX/PPTX', keys:['Ctrl+Shift+KeyX','Meta+Shift+KeyX'] },
  { id:'insert-page', label:'Новая страница DOCX / слайд PPTX', keys:['Ctrl+Enter','Meta+Enter'] },
  { id:'insert-section', label:'Новый раздел PPTX / страница DOCX', keys:['Ctrl+Shift+Enter','Meta+Shift+Enter'] },
  { id:'insert-slide', label:'Новый слайд PPTX', keys:['Ctrl+Alt+KeyN'] },
  { id:'brush', label:'Кисть на изображении', keys:['KeyB'] },
  { id:'eraser', label:'Ластик на изображении', keys:['KeyE'] },
  { id:'rectangle', label:'Выделение на изображении', keys:['KeyR'] },
  { id:'previous', label:'Предыдущая страница', keys:['PageUp','Alt+ArrowLeft'] },
  { id:'next', label:'Следующая страница', keys:['PageDown','Alt+ArrowRight'] },
  { id:'shortcut-settings', label:'Настройка горячих клавиш', keys:['Ctrl+Comma','Meta+Comma'] }
];
const windows = new WeakMap();
const listening=new WeakSet();
const defaults = () => Object.fromEntries(SHORTCUTS.map(item => [item.id,[...item.keys]]));
const codePattern = /^(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|F(?:[1-9]|1[0-9]|2[0-4])|Escape|Enter|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Left|Right|Up|Down)|Equal|Minus|Comma|Period|Slash|Backslash|Semicolon|Quote|BracketLeft|BracketRight|Backquote)$/;
export function normalizedBinding(value) {
  if (typeof value !== 'string') return null;
  const parts=value.split('+'),code=parts.pop();if(!codePattern.test(code))return null;
  if (parts.some(part=>!['Ctrl','Alt','Shift','Meta'].includes(part)) || new Set(parts).size!==parts.length)return null;
  return [...['Ctrl','Alt','Shift','Meta'].filter(part=>parts.includes(part)),code].join('+');
}
export function validatedBindings(input) {
  const result=defaults(),used=new Map();
  if(input && typeof input==='object')for(const item of SHORTCUTS){
    if(!Object.hasOwn(input,item.id))continue;
    if(!Array.isArray(input[item.id]) || input[item.id].length>12)throw new Error('Некорректный список сочетаний.');
    const keys=input[item.id].map(normalizedBinding);if(keys.some(key=>!key))throw new Error('Некорректное сочетание клавиш.');
    result[item.id]=[...new Set(keys)];
  }
  for(const item of SHORTCUTS)for(const key of result[item.id]){
    if(used.has(key))throw new Error(`Это сочетание уже используется: «${used.get(key)}».`);
    used.set(key,item.label);
  }
  return result;
}
function currentWindow(event) {
  return event?.target?.ownerDocument?.defaultView || event?.view || globalThis.window;
}
export function getShortcutBindings(window=globalThis.window) {
  if(!window)return defaults();
  if(!listening.has(window)){
    listening.add(window);window.addEventListener('storage',event=>{
      if(event.key!==SHORTCUT_STORAGE && event.key!==null)return;
      try{applyShortcutBindings(JSON.parse(event.newValue||'{}'),window);}catch{}
    });
  }
  if(!windows.has(window)){
    let value;try{value=validatedBindings(JSON.parse(window.localStorage.getItem(SHORTCUT_STORAGE)||'{}'));}catch{value=defaults();}
    windows.set(window,value);
  }
  return structuredClone(windows.get(window));
}
/** Sandboxed Office frames receive the same map without accessing localStorage. */
export function applyShortcutBindings(input,window=globalThis.window,{persist=false}={}) {
  const value=validatedBindings(input);if(window){
    windows.set(window,value);
    if(persist){try{window.localStorage.setItem(SHORTCUT_STORAGE,JSON.stringify(value));}catch{} }
    window.dispatchEvent(new window.CustomEvent('omni-shortcuts-change',{detail:value}));
  }
  return value;
}
export function bindingFromEvent(event) {
  let code=event.code;
  if(!code){
    const key=event.key;
    if(/^[a-z]$/i.test(key||''))code='Key'+key.toUpperCase();
    else if(/^[0-9]$/.test(key||''))code='Digit'+key;
    else code=({'+':'Equal','=':'Equal','-':'Minus',',':'Comma',' ':'Space'})[key]||key;
  }
  if(!codePattern.test(code))return null;
  return [event.ctrlKey?'Ctrl':null,event.altKey?'Alt':null,event.shiftKey?'Shift':null,event.metaKey?'Meta':null,code].filter(Boolean).join('+');
}
export function shortcutCommand(event) {
  const binding=bindingFromEvent(event);if(!binding || event.isComposing || event.getModifierState?.('AltGraph'))return null;
  const settings=getShortcutBindings(currentWindow(event));
  return SHORTCUTS.find(item=>settings[item.id].includes(binding))?.id || null;
}
export function shortcutLabel(binding) {
  if(!binding)return 'Не назначено';
  return binding.split('+').map(part=>({Meta:'Cmd',Equal:'+',Minus:'−',Comma:',',Escape:'Esc',PageUp:'PgUp',PageDown:'PgDn',ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓',Space:'Пробел',NumpadAdd:'Num +',NumpadSubtract:'Num −',Numpad0:'Num 0'})[part]||part.replace(/^Key|^Digit/,'')).join('+');
}
export function isFullscreenShortcut(event){return shortcutCommand(event)==='focus';}
export function isThemeShortcut(event){return shortcutCommand(event)==='theme';}
export function editingShortcut(event){const command=shortcutCommand(event);return ['save','undo','redo'].includes(command)?command:null;}
export function zoomShortcut(event){const command=shortcutCommand(event);return command?.startsWith('zoom-')?command:null;}
export function formattingShortcut(event){const command=shortcutCommand(event);return ['bold','italic','underline','strike'].includes(command)?command:null;}
