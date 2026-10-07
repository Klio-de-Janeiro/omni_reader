import { openViewer } from '../viewers.js';
import { viewMode } from '../page-modes.js';
import { editingShortcut } from '../shortcuts.js';

const node = (tag, text) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  return element;
};
const button = text => { const element = node('button', text); element.type = 'button'; return element; };

/** Edit the displayed PDF pages, keeping navigation and undo in one document view. */
export async function openPdfUI(model, record, root, options) {
  const { signal, onSave, onClose, onError, onDirty, onViewMode, initialPage = 1, initialZoom = 1 } = options;
  let viewer, renderController, api, disposed = false, busy = false, working = false;
  let mode = viewMode(options.viewMode), page = initialPage, zoom = initialZoom;
  let order = model.pages.map(p => p.index), index = order[Math.min(order.length, initialPage) - 1];
  const panel = node('div'); panel.className = 'editor-panel pdf-editor';
  const bar = node('div'); bar.className = 'editor-bar';
  const undo = button('Отменить'), redo = button('Повторить');
  const rotate = button('Повернуть на 90°'), remove = button('Убрать страницу');
  rotate.title = 'Повернуть текущую страницу PDF'; remove.title = 'Удалить текущую страницу из копии; Ctrl+Z — вернуть';
  const before = button('‹'), after = button('›'), at = node('input'), count = node('span');
  before.setAttribute('aria-label', 'Предыдущая страница'); after.setAttribute('aria-label', 'Следующая страница');
  at.type = 'number'; at.min = 1; at.setAttribute('aria-label', 'Номер страницы редактора');
  const layout = node('select'); layout.setAttribute('aria-label', 'Режим просмотра редактора');
  for (const [value, label] of [['scroll', 'Прокрутка'], ['page', 'По страницам']]) {
    const option = node('option', label); option.value = value; layout.append(option);
  }
  const smaller = button('−'), larger = button('+'), scale = node('span');
  smaller.setAttribute('aria-label', 'Уменьшить масштаб'); larger.setAttribute('aria-label', 'Увеличить масштаб');
  const save = button('Сохранить копию'), close = button('К просмотру'), status = node('span');
  save.className = 'primary'; status.className = 'editor-status'; status.setAttribute('role', 'status');
  bar.append(undo, redo, rotate, remove, before, at, count, after, layout, smaller, scale, larger, save, close, status);
  const canvas = node('div'); canvas.className = 'viewer pdf-edit-canvas'; canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Страницы PDF. Редактирование: поворот и удаление страниц.');
  panel.append(bar, canvas); root.replaceChildren(panel);

  function update() {
    if (disposed) return;
    const locked = busy || working || !viewer;
    for (const control of bar.querySelectorAll('button,input,select')) control.disabled = locked;
    undo.disabled = locked || !model.history.done.length;
    redo.disabled = locked || !model.history.future.length;
    remove.disabled = locked || order.length <= 1;
    save.disabled = locked || !model.history.dirty;
    before.disabled = locked || page <= 1; after.disabled = locked || page >= order.length;
    if (!working) { at.value = page; layout.value = mode; }
    at.max = order.length; count.textContent = '/ ' + order.length; scale.textContent = Math.round(zoom * 100) + '%';
    status.textContent = locked ? 'Подготавливаем…' : model.history.dirty ? 'Есть несохранённые изменения' : 'Изменений нет';
    onDirty?.(model.history.dirty);
  }
  const guarded = action => async () => {
    if (busy || working || disposed) return;
    working = true; update();
    try { await action(); } catch (error) { if (!disposed) onError(error); }
    finally { working = false; update(); }
  };
  async function mount(original = false) {
    const file = original ? record.blob : new File([await model.export()], record.name);
    if (disposed) return;
    renderController?.abort(); viewer = null;
    const current = new AbortController(); renderController = current;
    order = model.pages.filter(p => p.keep).map(p => p.index);
    const selected = order.indexOf(index);
    page = selected >= 0 ? selected + 1 : Math.max(1, Math.min(order.length, page));
    index = order[page - 1];
    let positioned = false;
    viewer = await openViewer(file, canvas, {
      ext: 'pdf', signal: current.signal, viewMode: mode,
      onPage(value) { if (positioned) { page = value; index = order[page - 1]; update(); } },
      onZoom(value) { zoom = value; update(); },
      onWarning(error) { if (!disposed) onError(error); }
    });
    if (disposed) { current.abort(); return; }
    await viewer.setZoom(zoom); await viewer.setPage(page); positioned = true; update();
  }
  async function go(value) {
    page = Math.max(1, Math.min(order.length, Math.trunc(value) || 1)); index = order[page - 1];
    await viewer.setPage(page);
  }
  canvas.addEventListener('click', event => {
    const paper = event.target.closest('.pdf-paper');
    if (paper && !busy && !working) { page = Number(paper.dataset.page); index = order[page - 1]; update(); }
  });
  rotate.onclick = guarded(async () => { model.rotate(index); await mount(); });
  remove.onclick = guarded(async () => { model.toggle(index); await mount(); });
  undo.onclick = guarded(async () => { model.history.undo(); await mount(); });
  redo.onclick = guarded(async () => { model.history.redo(); await mount(); });
  before.onclick = guarded(() => go(page - 1)); after.onclick = guarded(() => go(page + 1));
  at.onchange = guarded(() => go(Number(at.value)));
  layout.onchange = guarded(async () => { const next = layout.value; await viewer.setViewMode(next); mode = next; onViewMode?.(mode); });
  const resize = delta => guarded(async () => { zoom = Math.max(0.5, Math.min(3, zoom + delta)); await viewer.setZoom(zoom); });
  smaller.onclick = resize(-0.25); larger.onclick = resize(0.25);
  save.onclick = guarded(() => onSave(api));
  close.onclick = async () => { if (!busy && !working) { try { await onClose(); } catch (error) { onError(error); } } };
  model.history.onChange = update;
  api = {
    get dirty() { return model.history.dirty; }, get busy() { return busy || working; },
    get position() { return { page, zoom }; },
    export: () => model.export(),
    navigate: delta => guarded(() => go(page + delta))(),
    adjustZoom: delta => resize(delta === null ? 1 - zoom : delta)(),
    setBusy(value) { busy = !!value; update(); },
    dispose() { disposed = true; renderController?.abort(); }
  };
  panel.addEventListener('keydown', event => {
    const action = editingShortcut(event);
    if (action) { event.preventDefault(); ({ save, undo, redo })[action].click(); }
  });
  signal.addEventListener('abort', () => api.dispose(), { once: true });
  if (signal.aborted) { api.dispose(); throw new DOMException('Aborted', 'AbortError'); }
  update(); await mount(true); return api;
}
