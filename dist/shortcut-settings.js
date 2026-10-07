import { SHORTCUTS, getShortcutBindings, applyShortcutBindings, bindingFromEvent, shortcutLabel } from './shortcuts.js';

/** Record physical keys, reject conflicts and persist each explicit assignment. */
export function initShortcutSettings(document) {
  const window=document.defaultView,dialog=document.getElementById('shortcuts-dialog'),rows=document.getElementById('shortcut-rows');
  const status=document.getElementById('shortcut-status'),controls=new Map();getShortcutBindings(window);
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  function refresh(){
    const values=getShortcutBindings(window);
    for(const item of SHORTCUTS){const field=controls.get(item.id);field.value=values[item.id].map(shortcutLabel).join(' / ')||'Не назначено';field.title=field.value;}
    window.dispatchEvent(new window.CustomEvent('omni-shortcut-labels'));
  }
  function commit(id,keys){
    const values=getShortcutBindings(window);values[id]=keys;
    try{applyShortcutBindings(values,window,{persist:true});status.textContent='Сохранено на этом устройстве.';refresh();return true;}
    catch(error){status.textContent=error.message;return false;}
  }
  for(const item of SHORTCUTS){
    const row=node('div');row.className='shortcut-row';const label=node('label',item.label),field=node('input');
    field.type='text';field.readOnly=true;field.setAttribute('aria-label',`Сочетание: ${item.label}`);field.id='shortcut-'+item.id;label.htmlFor=field.id;
    const clear=node('button','Убрать'),reset=node('button','Сброс');clear.type=reset.type='button';
    clear.setAttribute('aria-label',`Убрать сочетание: ${item.label}`);reset.setAttribute('aria-label',`Сбросить сочетание: ${item.label}`);
    field.onfocus=()=>{status.textContent='Нажмите новое сочетание. Tab переводит фокус на следующую настройку.';};
    field.onkeydown=event=>{
      if(event.key==='Tab' && !event.ctrlKey && !event.altKey && !event.metaKey)return;
      event.preventDefault();event.stopImmediatePropagation();const binding=bindingFromEvent(event);if(!binding || event.repeat)return;
      if(commit(item.id,[binding]))field.blur();
    };
    clear.onclick=()=>commit(item.id,[]);reset.onclick=()=>commit(item.id,item.keys);
    row.append(label,field,clear,reset);rows.append(row);controls.set(item.id,field);
  }
  const open=()=>{refresh();status.textContent='Щёлкните сочетание и нажмите клавиши. Новое назначение заменит все прежние варианты этой команды.';if(!dialog.open)dialog.showModal();};
  document.getElementById('hotkeys-settings').onclick=open;
  document.getElementById('shortcuts-close').onclick=()=>dialog.close();
  document.getElementById('shortcuts-reset').onclick=()=>{applyShortcutBindings({},window,{persist:true});status.textContent='Стандартные сочетания восстановлены.';refresh();};
  refresh();return {open,get bindings(){return getShortcutBindings(window);}};
}
