import { Marked } from '../vendor-sources/marked/marked.esm.js';
import katex from '../vendor-sources/katex/dist/katex.mjs';
import createDOMPurify from '../vendor-sources/dompurify/purify.es.mjs';

const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const htmlTags = new Set(['br', 'hr', 'p', 'div', 'span', 'u', 'sub', 'sup', 'b', 'i', 'strong', 'em', 's', 'del', 'blockquote', 'pre', 'code', 'details', 'summary', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'ul', 'ol', 'li']);
function safeHtml(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, tag => {
    const found = /^<\s*(\/?)\s*([a-z0-9]+)\b[^>]*>$/i.exec(tag);
    return found && htmlTags.has(found[2].toLowerCase()) ? `<${found[1]}${found[2].toLowerCase()}>` : escape(tag);
  });
}
function math(source, displayMode) {
  if (source.length > 10000) return `<code class="math-error">${escape(source)}</code>`;
  return katex.renderToString(source, { displayMode, throwOnError: false, trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20 });
}
const parser = new Marked({ gfm: true, breaks: false });
parser.use({
  extensions: [
    {
      name: 'displayMath', level: 'block',
      start: source => source.search(/\$\$|\\\[|\\begin\{(?:align\*?|equation\*?|gather\*?)\}/),
      tokenizer(source) {
        const found = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|(\\begin\{(align\*?|equation\*?|gather\*?)\}[\s\S]+?\\end\{\4\}))(?:[ \t]*\n|$)/.exec(source);
        if (found) return { type: 'displayMath', raw: found[0], text: found[1] ?? found[2] ?? found[3] };
      },
      renderer: token => math(token.text, true) + '\n'
    },
    {
      name: 'inlineMath', level: 'inline',
      start: source => source.search(/\$(?!\$)|\\\(/),
      tokenizer(source) {
        const found = /^(?:\$(?!\$)([^$\n]*?[^\s$\\])\$(?!\d)|\\\(([\s\S]+?)\\\))/.exec(source);
        if (found) return { type: 'inlineMath', raw: found[0], text: found[1] ?? found[2] };
      },
      renderer: token => math(token.text, false)
    }
  ],
  renderer: {
    html: token => safeHtml(token.text),
    checkbox: token => token.checked ? '☑ ' : '☐ ',
    code(token) {
      if (['math', 'tex', 'latex'].includes(token.lang?.trim().toLowerCase())) return math(token.text, true) + '\n';
      return `<pre><code>${escape(token.text)}</code></pre>\n`;
    }
  }
});

/** Render local Markdown/math without executing HTML or requesting file resources. */
export function renderMarkup(source, ext, window) {
  source = source.replace(/^\uFEFF/, '');
  const standaloneMath = ext === 'tex' && !/\\(?:documentclass|begin\{document\}|usepackage)|\$|\\[\[(]|^\s*```/m.test(source)
    && /[\\^_=]/.test(source);
  const html = standaloneMath ? math(source, true) : parser.parse(source);
  const clean = createDOMPurify(window).sanitize(html, {
    RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['id', 'name', 'srcset', 'formaction', 'autofocus']
  });
  for (const node of clean.querySelectorAll('*')) {
    if (!node.closest('.katex')) {
      const align = node.style?.textAlign;
      node.removeAttribute('style'); node.removeAttribute('class');
      if (['left', 'center', 'right'].includes(align)) node.style.textAlign = align;
    }
    for (const attr of ['href', 'xlink:href', 'src', 'poster', 'background']) {
      if (!node.hasAttribute(attr)) continue;
      if (node.tagName === 'IMG' && attr === 'src' && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(node.getAttribute(attr))) continue;
      node.removeAttribute(attr);
    }
    if (node.tagName === 'IMG' && !node.hasAttribute('src')) {
      const placeholder = window.document.createElement('span');
      placeholder.className = 'markdown-image-placeholder'; placeholder.textContent = node.getAttribute('alt') || 'Изображение';
      node.replaceWith(placeholder);
    }
  }
  if (/\\(?:documentclass|begin\{document\})/.test(source)) {
    const note = window.document.createElement('p'); note.className = 'markup-note';
    note.textContent = 'Поддерживаются формулы LaTeX и Markdown-блоки. Полный TeX-проект с пакетами и вёрсткой нужно компилировать в PDF.';
    clean.prepend(note);
  }
  return clean;
}
