import { History } from './history.js';

/** Rotate or omit pages while keeping the original document available for undo. */
export async function openPdfEditor(bytes) {
  const { PDFDocument, degrees } = await import('../vendor/pdf-lib.js');
  const source = new Uint8Array(bytes).slice();
  const doc = await PDFDocument.load(source);
  const pages = doc.getPages().map((page, index) => ({ index, rotation: page.getRotation().angle, keep: true }));
  const history = new History();
  function set(index, next) {
    if (!pages[index]) throw new Error('Страница не найдена.');
    const previous = { ...pages[index] };
    if (!next.keep && pages.filter(page => page.keep).length <= 1 && previous.keep) throw new Error('В PDF должна остаться хотя бы одна страница.');
    history.execute(() => Object.assign(pages[index], next), () => Object.assign(pages[index], previous));
  }
  return { history, pages,
    rotate(index) { set(index, { ...pages[index], rotation: (pages[index].rotation + 90) % 360 }); },
    toggle(index) { set(index, { ...pages[index], keep: !pages[index].keep }); },
    async export() {
      const copy = await PDFDocument.load(source);
      for (const page of pages) copy.getPage(page.index).setRotation(degrees(page.rotation));
      for (let i = pages.length - 1; i >= 0; i--) if (!pages[i].keep) copy.removePage(i);
      return copy.save();
    },
  };
}
