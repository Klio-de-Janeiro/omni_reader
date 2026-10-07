import { all, attr, elements, local, node, parse, resolvePart } from './xml.js';
const uuid = () => '{'+Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5').toUpperCase()+'}';
const relPath = path => path.replace(/([^/]+)$/, '_rels/$1.rels');
const slideType = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
/** Insert a standalone slide linked to the existing layout; maintain section membership. */
export async function insertSlide(pack, paths, afterIndex, sectionName, changed, history) {
  const presentation = await pack.read('ppt/presentation.xml'), relations = await pack.read('ppt/_rels/presentation.xml.rels'), types = await pack.read('[Content_Types].xml');
  const index = Math.max(0,Math.min(paths.length-1,afterIndex));
  const before = [presentation,relations,types].map(value=>structuredClone(value));
  let number = 1; while (pack.zip.file('ppt/slides/slide'+number+'.xml') || pack.parts.has('ppt/slides/slide'+number+'.xml')) number++;
  const path = 'ppt/slides/slide'+number+'.xml';
  const oldRels = pack.zip.file(relPath(paths[index])) || pack.parts.has(relPath(paths[index])) ? await pack.read(relPath(paths[index])) : null;
  const layout = oldRels && all(oldRels,'Relationship').find(r=>attr(r,'Type')?.endsWith('/slideLayout'));
  const size = all(presentation,'sldSz')[0], width = Number(attr(size,'cx')) || 9144000;
  const slide = parse('<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Новый текст"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="'+Math.max(914400,width-914400)+'" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="ru-RU" sz="2400"/><a:t>Новый слайд</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');
  const slideRels = parse('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  slideRels.elements[0].elements ||= [];
  if (layout) {
    // New slides are in the same directory; a validated layout target is reusable.
    resolvePart(path,attr(layout,'Target'));
    slideRels.elements[0].elements.push(structuredClone(layout));
  }
  const ids = all(presentation,'sldId').filter(n=>n.name==='p:sldId');
  const slideId = String(Math.max(255,...ids.map(n=>Number(attr(n,'id')) || 0))+1);
  let relId = 1; while(all(relations,'Relationship').some(n=>attr(n,'Id')==='rId'+relId)) relId++;
  const list = all(presentation,'sldIdLst').find(n=>n.name==='p:sldIdLst');
  if (!list) throw new Error('В презентации нет списка слайдов.');
  list.elements.splice(list.elements.indexOf(ids[index])+1,0,node('p:sldId',{id:slideId,'r:id':'rId'+relId}));
  relations.elements[0].elements.push(node('Relationship',{Id:'rId'+relId,Type:'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',Target:'slides/slide'+number+'.xml'}));
  types.elements[0].elements.push(node('Override',{PartName:'/'+path,ContentType:slideType}));
  let sections = all(presentation,'section').filter(n=>n.name==='p14:section');
  if (sectionName) {
    const root = presentation.elements.find(n=>n.type==='element'); root.attributes['xmlns:p14']='http://schemas.microsoft.com/office/powerpoint/2010/main';
    let sectionList = all(presentation,'sectionLst').find(n=>n.name==='p14:sectionLst');
    if (!sectionList) {
      let extList = elements(root).find(n=>local(n)==='extLst');
      if (!extList) {extList=node('p:extLst');root.elements.push(extList);}
      extList.elements ||= [];
      sectionList=node('p14:sectionLst');extList.elements.push(node('p:ext',{uri:'{521415D9-36F7-43E2-AB2F-B90AF26B5E84}'},[sectionList]));
      const first=node('p14:section',{name:'Основной раздел',id:uuid()},[node('p14:sldIdLst',{},ids.map(n=>node('p14:sldId',{id:attr(n,'id')})))]);
      sectionList.elements.push(first);sections=[first];
    }
    const selectedId=attr(ids[index],'id'), selected=sections.find(s=>all(s,'sldId').some(n=>attr(n,'id')===selectedId));
    const members=selected && all(selected,'sldIdLst')[0], cut=members?elements(members).findIndex(n=>attr(n,'id')===selectedId)+1:0;
    const following=members?members.elements.splice(cut):[];
    const section=node('p14:section',{name:String(sectionName).slice(0,128),id:uuid()},[node('p14:sldIdLst',{},[node('p14:sldId',{id:slideId}),...following])]);
    sectionList.elements.splice(selected?sectionList.elements.indexOf(selected)+1:sectionList.elements.length,0,section);
  } else {
    const selectedId=attr(ids[index],'id'), section=sections.find(s=>all(s,'sldId').some(n=>attr(n,'id')===selectedId));
    if(section){const members=all(section,'sldIdLst')[0];const selected=elements(members).find(n=>attr(n,'id')===selectedId);members.elements.splice(members.elements.indexOf(selected)+1,0,node('p14:sldId',{id:slideId}));}
  }
  const after = [presentation,relations,types].map(value=>structuredClone(value));
  const partPaths = ['ppt/presentation.xml','ppt/_rels/presentation.xml.rels','[Content_Types].xml'];
  const apply = (snapshots, exists) => {
    partPaths.forEach((p,i)=>{pack.parts.set(p,structuredClone(snapshots[i]));changed.add(p);});
    // Retain paragraph identity so text edits can be redone after undoing the insertion.
    if(exists){pack.parts.set(path,slide);pack.parts.set(relPath(path),slideRels);}
    else{pack.parts.delete(path);pack.parts.delete(relPath(path));}
    changed.add(path);changed.add(relPath(path));
  };
  history.execute(()=>apply(after,true),()=>apply(before,false));
  return {page:index+2,path};
}
