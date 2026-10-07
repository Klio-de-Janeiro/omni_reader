import { History, checkedText } from '../../dist/editors/history.js';
import { Package, all, attr, textOf, textNode, resolvePart, elements, local, node, walk } from './xml.js';
import { segmentsOf, normalizeSegments, editableParagraph, writeParagraph } from './rich-office.js';
import { insertSlide } from './slides.js';

/** Edit existing text runs, retaining their formatting and all unrelated parts. */
export async function openOfficeEditor(bytes, ext) {
  const pack = await Package.open(bytes), history = new History(), fragments = [], changed = new Set();
  let paths;
  if (ext === 'docx') {
    const settings = pack.zip.file('word/settings.xml') ? await pack.read('word/settings.xml') : null;
    if (settings && all(settings, 'documentProtection').some(item => !['0', 'false', 'off'].includes(attr(item, 'w:enforcement')))) throw new Error('Редактирование защищённого DOCX не поддерживается.');
    paths = ['word/document.xml', ...Object.keys(pack.zip.files).filter(path => /^word\/(header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(path)).sort()];
  } else {
    const presentation = await pack.read('ppt/presentation.xml');
    const rels = all(await pack.read('ppt/_rels/presentation.xml.rels'), 'Relationship');
    const ids = new Map(rels.filter(item => attr(item, 'TargetMode') !== 'External').map(item => [attr(item, 'Id'), resolvePart('ppt/presentation.xml', attr(item, 'Target'))]));
    paths = all(presentation, 'sldId').map(item => ids.get(attr(item, 'r:id'))).filter(Boolean);
  }
  for (const [partIndex, path] of paths.entries()) {
    const tree = await pack.read(path);
    const runs = all(tree, 't').filter(item => item.name === (ext === 'docx' ? 'w:t' : 'a:t'));
    for (const [runIndex, item] of runs.entries()) {
      if (fragments.length >= 20000) throw new Error('Редактор поддерживает до 20 000 текстовых фрагментов.');
      fragments.push({ item, path, original: textOf(item), label: ext === 'pptx' ? `Слайд ${partIndex + 1} · фрагмент ${runIndex + 1}` : `${path === 'word/document.xml' ? 'Документ' : path.split('/').at(-1)} · фрагмент ${runIndex + 1}` });
    }
  }
  const states = new WeakMap(), templates = new WeakMap();
  let blocks = [];
  async function refreshBlocks() {
    if (ext === 'pptx') {
      const presentation = await pack.read('ppt/presentation.xml'), rels = all(await pack.read('ppt/_rels/presentation.xml.rels'),'Relationship');
      const ids = new Map(rels.filter(n=>attr(n,'TargetMode')!=='External').map(n=>[attr(n,'Id'),resolvePart('ppt/presentation.xml',attr(n,'Target'))]));
      paths = all(presentation,'sldId').filter(n=>n.name==='p:sldId').map(n=>ids.get(attr(n,'r:id'))).filter(Boolean);
    }
    blocks = [];
    for (const [partIndex,path] of paths.entries()) {
      const tree = await pack.read(path), parents = new Map();
      walk(tree,(n,p)=>parents.set(n,p));
      const paragraphs = all(tree,'p').filter(n=>n.name === (ext === 'docx'?'w:p':'a:p'));
      for (const [paragraphIndex,p] of paragraphs.entries()) {
        let owner = parents.get(p), shapeId = null, paragraphInShape = 0;
        if(ext==='pptx'){
          const body = owner; paragraphInShape = elements(body).filter(n=>n.name==='a:p').indexOf(p);
          while(owner && !['sp','graphicFrame'].includes(local(owner)))owner=parents.get(owner);
          shapeId = attr(owner && all(owner,'cNvPr')[0],'id');
        }
        if(!states.has(p))states.set(p,segmentsOf(p,ext));
        if(!templates.has(p))templates.set(p,elements(p).filter(n=>local(n)==='r').map(n=>structuredClone(n)));
        blocks.push({id:path+'#'+paragraphIndex,path,partIndex,paragraphIndex,shapeId,paragraphInShape,editable:editableParagraph(p,ext),p,parent:parents.get(p),segments:states.get(p),templates:templates.get(p)});
      }
    }
    if(blocks.length>20000)throw new Error('Редактор поддерживает до 20 000 абзацев.');
  }
  await refreshBlocks();
  return {
    history, fragments,
    get pageCount() {return ext==='pptx'?paths.length:1;},
    getBlocks() {return blocks.map(({p,parent,templates,...b})=>({...b,segments:structuredClone(states.get(p)),text:states.get(p).map(s=>s.text).join('')}));},
    getBlock(id) {return this.getBlocks().find(b=>b.id===id);},
    setParagraph(id, segments, mergeKey = null) {
      const b=blocks.find(b=>b.id===id);if(!b || !b.editable)throw new Error('Этот абзац содержит сложные объекты и доступен только для чтения.');
      const next=normalizeSegments(segments), previous=structuredClone(states.get(b.p));
      if(JSON.stringify(next)===JSON.stringify(previous))return;
      const before=structuredClone(b.p), after=structuredClone(b.p);writeParagraph(after,next,b.templates,ext);
      const apply=(value,state)=>{for(const key of Object.keys(b.p))delete b.p[key];Object.assign(b.p,structuredClone(value));states.set(b.p,structuredClone(state));changed.add(b.path);};
      history.execute(()=>apply(after,next),()=>apply(before,previous),mergeKey);
    },
    async insert(kind, after = 0) {
      if(ext==='pptx'){
        const result=await insertSlide(pack,paths,Number(after)-1,kind==='section'?'Новый раздел':null,changed,history);
        await refreshBlocks();return result;
      }
      const b=blocks.find(b=>b.id===after) || blocks.find(b=>b.path==='word/document.xml');
      if(!b)throw new Error('Нет абзаца для вставки.');
      const properties=elements(b.p).find(n=>local(n)==='pPr'), p=node('w:p',{},properties?[structuredClone(properties)]:[]);
      const copiedProperties=elements(p).find(n=>local(n)==='pPr');
      if(copiedProperties)copiedProperties.elements=(copiedProperties.elements || []).filter(n=>local(n)!=='pageBreakBefore');
      if(kind==='page'){
        let pPr=elements(p).find(n=>local(n)==='pPr');
        if(!pPr){pPr=node('w:pPr');p.elements.push(pPr);}
        pPr.elements=(pPr.elements || []).filter(n=>local(n)!=='pageBreakBefore');pPr.elements.push(node('w:pageBreakBefore'));
      }
      writeParagraph(p,[{text:kind==='page'?'Новая страница':'Новый абзац',style:{},template:0}],b.templates,ext);
      const place=b.parent.elements.indexOf(b.p)+1;
      history.execute(()=>{b.parent.elements.splice(place,0,p);changed.add(b.path);},()=>{const at=b.parent.elements.indexOf(p);if(at>=0)b.parent.elements.splice(at,1);changed.add(b.path);});
      await refreshBlocks();return {id:blocks.find(n=>n.p===p)?.id};
    },
    async refresh() {await refreshBlocks();},
    getText(index) { return textOf(fragments[index].item); },
    setText(index, value) {
      value = checkedText(value); if (/[\r\n\t]/.test(value)) throw new Error('В этой версии правится текст внутри фрагмента. Новые абзацы и табуляция пока не поддерживаются.');
      const fragment = fragments[index]; if (!fragment) throw new Error('Фрагмент не найден.');
      if (value === textOf(fragment.item)) return;
      const before = structuredClone(fragment.item), apply = (data) => {
        for (const key of Object.keys(fragment.item)) delete fragment.item[key]; Object.assign(fragment.item, structuredClone(data));
        changed.add(fragment.path);
      };
      const after = { ...before, attributes: { ...before.attributes, 'xml:space': 'preserve' }, elements: [textNode(value)] };
      history.execute(() => apply(after), () => apply(before));
    },
    export() { return pack.export(changed.keys()); },
  };
}
