import { checkedText } from '../../dist/editors/history.js';
import { elements, local, attr, all, node, textNode, textOf } from './xml.js';

export const styleKeys = ['bold', 'italic', 'underline', 'strike'];
const child = (p, name) => elements(p).find(n => local(n) === name);
const clone = value => structuredClone(value);
export function runStyle(run, ext) {
  const r = child(run, 'rPr'), style = {};
  if (ext === 'docx') {
    for (const [key, name] of [['bold','b'],['italic','i'],['underline','u'],['strike','strike']]) {
      const flag = child(r || {}, name);
      if (flag) style[key] = !['0','false','off','none'].includes(attr(flag, 'w:val'));
    }
  } else {
    for (const [key, name] of [['bold','b'],['italic','i'],['underline','u'],['strike','strike']]) {
      const value = attr(r, name);
      if (value != null) style[key] = !['0','false','none','noStrike'].includes(value);
    }
  }
  return style;
}
export function segmentsOf(paragraph, ext) {
  const result = []; let template = 0;
  for (const run of elements(paragraph).filter(n => ['r','br'].includes(local(n)))) {
    if (local(run) === 'br') { result.push({text:'\n',style:runStyle(run,ext),template:Math.max(0,template-1)}); continue; }
    let text = '';
    for (const n of elements(run)) {
      if (local(n) === 't') text += textOf(n);
      if (local(n) === 'br') text += '\n';
      if (local(n) === 'tab') text += '\t';
    }
    result.push({ text, style: runStyle(run, ext), template: template++ });
  }
  return result.length ? result : [{text:'',style:{},template:0}];
}
export function normalizeSegments(segments) {
  if (!Array.isArray(segments) || segments.length > 10000) throw new Error('Слишком много фрагментов оформления.');
  let size = 0;
  return segments.map(s => {
    const text = checkedText(s.text); size += text.length;
    if (size > 32767) throw new Error('Лимит абзаца: 32767 символов.');
    const style = {};
    for (const key of styleKeys) if (typeof s.style?.[key] === 'boolean') style[key] = s.style[key];
    return {text,style,template:Number.isInteger(s.template) && s.template >= 0 ? s.template : 0};
  });
}
export function formatSegments(segments, start, end, key, value) {
  if (!styleKeys.includes(key)) throw new Error('Неизвестное оформление.');
  let position = 0; const result = [];
  for (const s of segments) {
    const from = Math.max(0,start-position), to = Math.min(s.text.length,end-position);
    if (to > from) {
      if (from) result.push({...s,text:s.text.slice(0,from)});
      result.push({...s,text:s.text.slice(from,to),style:{...s.style,[key]:!!value}});
      if (to < s.text.length) result.push({...s,text:s.text.slice(to)});
    } else result.push(clone(s));
    position += s.text.length;
  }
  return result;
}
export function editableParagraph(p, ext) {
  const allowed = ext === 'docx' ? ['pPr','r','bookmarkStart','bookmarkEnd','proofErr'] : ['pPr','r','br','endParaRPr'];
  return elements(p).every(n => allowed.includes(local(n)) && (local(n) !== 'r' || elements(n).every(r => ['rPr','t','br','tab'].includes(local(r)))));
}
/** Change four style flags while retaining size, color, typeface and all other run properties. */
export function writeParagraph(paragraph, segments, templates, ext) {
  const prefix = ext === 'docx' ? 'w:' : 'a:';
  const runs = [];
  for (const s of normalizeSegments(segments)) {
    const original = templates[s.template] || templates[0] || node(prefix+'r');
    const props = clone(child(original,'rPr') || node(prefix+'rPr'));
    for (const [key,name] of [['bold','b'],['italic','i'],['underline','u'],['strike','strike']]) {
      if (typeof s.style[key] !== 'boolean') continue;
      if (ext === 'docx') {
        props.elements = (props.elements || []).filter(n => local(n) !== name);
        props.elements.push(node('w:'+name, {'w:val':key === 'underline' ? (s.style[key]?'single':'none') : s.style[key]?'1':'0'}));
      } else {
        props.attributes ||= {};
        props.attributes[name] = key === 'underline' ? (s.style[key]?'sng':'none') : key === 'strike' ? (s.style[key]?'sngStrike':'noStrike') : s.style[key]?'1':'0';
      }
    }
    const chunks = s.text.split(ext === 'docx' ? /(\n|\t)/ : /(\n)/);
    const content = props.elements?.length || Object.keys(props.attributes || {}).length ? [props] : [];
    for (const text of chunks) {
      if (text === '\n' || (text === '\t' && ext === 'docx')) {
        if (ext === 'pptx') {
          if (content.length > (content[0] === props ? 1:0)) runs.push(node('a:r',{},content.splice(0)));
          runs.push(node('a:br',{},[clone(props)]));
          content.push(clone(props));
        } else content.push(node(text === '\n'?'w:br':'w:tab'));
      } else if (text || chunks.length === 1) content.push(node(prefix+'t', {'xml:space':'preserve'},[textNode(text)]));
    }
    if (content.length) runs.push(node(prefix+'r',clone(original.attributes || {}),content));
  }
  const before = elements(paragraph).filter(n => local(n) === 'pPr' || ['bookmarkStart','proofErr'].includes(local(n)));
  const after = elements(paragraph).filter(n => ['endParaRPr','bookmarkEnd'].includes(local(n)));
  paragraph.elements = [...before,...runs,...after];
}
