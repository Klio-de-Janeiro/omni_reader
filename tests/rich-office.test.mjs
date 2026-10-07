import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import JSZip from 'jszip';
import {openOfficeEditor} from '../dist/vendor/editors.js';
import {formatSegments} from '../scripts/editors/rich-office.js';
const array=b=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
const fixture=ext=>readFile(new URL('./fixtures/sample.'+ext,import.meta.url));
async function output(name,bytes){await mkdir('test-results/rich',{recursive:true});await writeFile('test-results/rich/'+name,bytes);}
for(const ext of ['docx','pptx'])test(ext+' preserves four styles, Unicode, font properties and unrelated parts through rich export',async()=>{
  const original=await fixture(ext),zip=await JSZip.loadAsync(original),model=await openOfficeEditor(array(original),ext);
  const block=model.getBlocks().find(b=>b.editable),before=block.text;
  model.setParagraph(block.id,[{text:'Клио <&> 😀',style:{bold:true,italic:true,underline:true,strike:true},template:0},{text:'\nВторая строка\t✓',style:{italic:false},template:0}]);
  const bytes=await model.export(),again=await openOfficeEditor(array(bytes),ext),edited=again.getBlocks().find(b=>b.id===block.id);
  assert.equal(edited.text,'Клио <&> 😀\nВторая строка\t✓');assert.deepEqual(edited.segments[0].style,{bold:true,italic:true,underline:true,strike:true});
  const after=await JSZip.loadAsync(bytes);
  for(const name of Object.keys(zip.files))if(!zip.files[name].dir && name!==block.path)assert.deepEqual(await after.file(name).async('uint8array'),await zip.file(name).async('uint8array'),name);
  model.history.undo();assert.equal(model.getBlock(block.id).text,before);model.history.redo();await output('formatted.'+ext,await model.export());
});
test('Partial formatting leaves unselected text and existing typefaces untouched',async()=>{
  const zip=await JSZip.loadAsync(await fixture('docx')),path='word/document.xml';let xml=await zip.file(path).async('string');
  xml=xml.replace('<w:r>','<w:r><w:rPr><w:rFonts w:ascii="Arial"/><w:color w:val="123456"/><w:sz w:val="32"/></w:rPr>');
  zip.file(path,xml);const model=await openOfficeEditor(array(await zip.generateAsync({type:'uint8array'})),'docx'),b=model.getBlocks()[0];
  const result=formatSegments(b.segments,5,9,'bold',true);model.setParagraph(b.id,result);
  const saved=await JSZip.loadAsync(await model.export()),text=await saved.file(path).async('string');assert.match(text,/Arial/);assert.match(text,/123456/);assert.equal(model.getBlock(b.id).text,b.text);
  const again=await openOfficeEditor(array(await model.export()),'docx');assert.equal(again.getBlocks()[0].segments[0].style.bold,undefined);assert.equal(again.getBlocks()[0].segments[1].style.bold,true);
});
test('DOCX inserts a paragraph and a page, and structure survives export and undo/redo',async()=>{
  const model=await openOfficeEditor(array(await fixture('docx')),'docx'),first=model.getBlocks()[0],n=model.getBlocks().length;
  await model.insert('paragraph',first.id);const result=await model.insert('page',first.id);assert.ok(result.id);assert.equal(model.getBlocks().length,n+2);
  await output('page.docx',await model.export());const zip=await JSZip.loadAsync(await model.export());assert.match(await zip.file('word/document.xml').async('string'),/pageBreakBefore/);
  model.history.undo();await model.refresh();assert.equal(model.getBlocks().length,n+1);model.history.redo();await model.refresh();assert.equal(model.getBlocks().length,n+2);
});
test('PPTX inserts slides and actual OOXML sections with correct order and reversible parts',async()=>{
  const model=await openOfficeEditor(array(await fixture('pptx')),'pptx');
  await model.insert('slide',1);await model.insert('section',2);assert.equal(model.pageCount,4);
  const bytes=await model.export(),zip=await JSZip.loadAsync(bytes),presentation=await zip.file('ppt/presentation.xml').async('string');
  assert.match(presentation,/p14:sectionLst/);assert.match(presentation,/Новый раздел/);assert.match(await zip.file('[Content_Types].xml').async('string'),/slide3\.xml/);
  const again=await openOfficeEditor(array(bytes),'pptx');assert.equal(again.pageCount,4);await output('sections.pptx',bytes);
  model.history.undo();await model.refresh();assert.equal(model.pageCount,3);const undone=await JSZip.loadAsync(await model.export());assert.equal(undone.file('ppt/slides/slide4.xml'),null);
  model.history.redo();await model.refresh();assert.equal(model.pageCount,4);
});
test('Inline input groups a burst into one undo action while formatting remains separate',async()=>{
  const model=await openOfficeEditor(array(await fixture('docx')),'docx'),b=model.getBlocks()[0],initial=b.text;
  for(const text of ['A','AB','ABC'])model.setParagraph(b.id,[{text,style:{},template:0}],'input:'+b.id);
  assert.equal(model.history.done.length,1);model.setParagraph(b.id,[{text:'ABC',style:{bold:true},template:0}]);assert.equal(model.history.done.length,2);model.history.undo();assert.equal(model.getBlock(b.id).text,'ABC');model.history.undo();assert.equal(model.getBlock(b.id).text,initial);
});
test('Text on an inserted slide is restored after undoing and redoing both text and structure',async()=>{
  const model=await openOfficeEditor(array(await fixture('pptx')),'pptx');await model.insert('slide',1);
  const b=model.getBlocks().find(n=>n.partIndex===1);model.setParagraph(b.id,[{text:'Новый слайд с правкой ✓',style:{bold:true},template:0}]);
  model.history.undo();model.history.undo();await model.refresh();assert.equal(model.pageCount,2);
  model.history.redo();await model.refresh();model.history.redo();await model.refresh();
  const again=await openOfficeEditor(array(await model.export()),'pptx');assert.equal(again.pageCount,3);assert.equal(again.getBlocks().find(n=>n.partIndex===1).text,'Новый слайд с правкой ✓');
});
test('An empty DOCX paragraph can be edited without requiring an existing text run',async()=>{
  const zip=await JSZip.loadAsync(await fixture('docx'));zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr/></w:body></w:document>');
  const model=await openOfficeEditor(array(await zip.generateAsync({type:'uint8array'})),'docx'),b=model.getBlocks()[0];assert.ok(b.editable);assert.equal(b.text,'');
  model.setParagraph(b.id,[{text:'Первый текст ✓',style:{bold:true},template:0}]);
  const again=await openOfficeEditor(array(await model.export()),'docx');assert.equal(again.getBlocks()[0].text,'Первый текст ✓');assert.equal(again.getBlocks()[0].segments[0].style.bold,true);
});
test('Turning all four styles off writes valid Word and PowerPoint values',async()=>{
  for(const ext of ['docx','pptx']){
    const model=await openOfficeEditor(array(await fixture(ext)),ext),b=model.getBlocks()[0],all={bold:true,italic:true,underline:true,strike:true};
    model.setParagraph(b.id,[{text:'Оформление выключено',style:all,template:0}]);model.setParagraph(b.id,[{text:'Оформление выключено',style:Object.fromEntries(Object.keys(all).map(k=>[k,false])),template:0}]);
    const bytes=await model.export(),again=await openOfficeEditor(array(bytes),ext);assert.deepEqual(again.getBlocks()[0].segments[0].style,{bold:false,italic:false,underline:false,strike:false});
    if(ext==='docx'){const zip=await JSZip.loadAsync(bytes);assert.match(await zip.file('word/document.xml').async('string'),/<w:u w:val="none"/);}
    await output('no-styles.'+ext,bytes);
  }
});
