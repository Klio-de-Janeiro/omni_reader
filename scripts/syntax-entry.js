import hljs from '../vendor-sources/highlightjs/lib/core.js';
import javascript from '../vendor-sources/highlightjs/lib/languages/javascript.js';
import typescript from '../vendor-sources/highlightjs/lib/languages/typescript.js';
import json from '../vendor-sources/highlightjs/lib/languages/json.js';
import yaml from '../vendor-sources/highlightjs/lib/languages/yaml.js';
import python from '../vendor-sources/highlightjs/lib/languages/python.js';
import bash from '../vendor-sources/highlightjs/lib/languages/bash.js';
import powershell from '../vendor-sources/highlightjs/lib/languages/powershell.js';
import markdown from '../vendor-sources/highlightjs/lib/languages/markdown.js';
import xml from '../vendor-sources/highlightjs/lib/languages/xml.js';
import css from '../vendor-sources/highlightjs/lib/languages/css.js';
import cpp from '../vendor-sources/highlightjs/lib/languages/cpp.js';
import c from '../vendor-sources/highlightjs/lib/languages/c.js';
import sql from '../vendor-sources/highlightjs/lib/languages/sql.js';
import latex from '../vendor-sources/highlightjs/lib/languages/latex.js';
import rust from '../vendor-sources/highlightjs/lib/languages/rust.js';
import java from '../vendor-sources/highlightjs/lib/languages/java.js';
import go from '../vendor-sources/highlightjs/lib/languages/go.js';
import ini from '../vendor-sources/highlightjs/lib/languages/ini.js';
for(const [name,language] of Object.entries({javascript,typescript,json,yaml,python,bash,powershell,markdown,xml,css,cpp,c,sql,latex,rust,java,go,ini}))hljs.registerLanguage(name,language);
hljs.registerLanguage('env',language=>({name:'Environment',keywords:'export',contains:[language.HASH_COMMENT_MODE,language.QUOTE_STRING_MODE,language.APOS_STRING_MODE,{scope:'attr',match:/^[ \t]*[A-Za-z_][\w]*(?=[ \t]*=)/m},language.NUMBER_MODE]}));
const aliases={js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',yml:'yaml',py:'python',python3:'python',sh:'bash',shell:'bash',zsh:'bash',dotenv:'env',md:'markdown',html:'xml',svg:'xml',tex:'latex','c++':'cpp',rs:'rust',ps1:'powershell',ps:'powershell'};
const escape=source=>source.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
export function syntaxHtml(source,language) {
  language=aliases[String(language).toLowerCase()]||String(language).toLowerCase();
  if(source.length>500000 || !hljs.getLanguage(language))return escape(source);
  try{return hljs.highlight(source,{language,ignoreIllegals:true}).value;}catch{return escape(source);}
}
