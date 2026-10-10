import { copyText } from './clipboard.js';

/** Show a desktop-only local Whisper action beneath the current audio player. */
export function mountSpeech(panel, file, context) {
  const host = window.omniDesktop;
  if (!host?.speechRun || context.signal.aborted) return;
  const document = panel.ownerDocument;
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
  const button = text => { const el = node('button', text); el.type = 'button'; return el; };
  const area = node('section', '', 'speech-panel'), actions = node('div', '', 'speech-actions');
  area.setAttribute('aria-label', 'Локальное распознавание речи');
  const run = button('Распознать речь'), cancel = button('Отменить распознавание'), settings = button('Настройки Whisper');
  run.className = 'primary'; cancel.hidden = true; actions.append(run, cancel, settings);
  const details = node('details', '', 'speech-settings'); details.append(node('summary', 'Python и локальная модель'));
  const chosen = new Map(), pickers = [];
  for (const [key, title, kinds] of [
    ['python', 'Python', [['python', 'Выбрать Python']]],
    ['model', 'Модель', [['model-file', 'Выбрать .pt'], ['model-folder', 'Выбрать папку']]],
    ['ffmpeg', 'FFmpeg для .pt', [['ffmpeg', 'Выбрать ffmpeg.exe']]]
  ]) {
    const row = node('div', '', 'speech-setting'), value = node('span', 'Не выбран', 'speech-setting-path');
    row.append(node('strong', title), value); chosen.set(key, value);
    for (const [kind, label] of kinds) {
      const choose = button(label); pickers.push(choose);
      choose.onclick = async () => {
        if (busy || configuring || disposed) return;
        configuring = true; run.disabled = settings.disabled = true; for (const picker of pickers) picker.disabled = true;
        try { const next = await host.speechChoose(kind); if (!disposed && next) { config = next; updateSettings(); status.textContent = 'Настройки сохранены.'; } }
        catch (error) { if (!disposed) status.textContent = error.message; }
        finally { configuring = false; if (!disposed) { run.disabled = settings.disabled = false; for (const picker of pickers) picker.disabled = false; } }
      };
      row.append(choose);
    }
    details.append(row);
  }
  details.append(node('p', 'Выберите Python из окружения, где уже установлен Whisper, и скачанную модель. Для faster-whisper FFmpeg отдельно не нужен.', 'speech-note'));
  const status = node('p', 'Загружаем настройки…', 'speech-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const output = node('textarea', '', 'speech-result'); output.readOnly = true; output.rows = 10; output.hidden = true; output.setAttribute('aria-label', 'Распознанная речь');
  const copy = button('Копировать текст'); copy.hidden = true;
  area.append(actions, details, status, output, copy); panel.append(area);
  let busy = false, configuring = false, disposed = false, id, config = null;
  function updateSettings() { for (const [key, el] of chosen) { el.textContent = config?.[key] || 'Не выбран'; el.title = config?.[key] || ''; } }
  function lock(value) { busy = value; run.disabled = settings.disabled = value; cancel.hidden = !value; for (const picker of pickers) picker.disabled = value; }
  settings.onclick = () => { details.open = !details.open; };
  copy.onclick = async () => { try { await copyText(output.value); status.textContent = 'Текст скопирован.'; } catch (error) { status.textContent = error.message; } };
  const off = host.onSpeechProgress(message => {
    if (disposed || message.id !== id) return;
    if (message.type === 'status') status.textContent = message.message;
    else if (message.type === 'segment') { output.hidden = false; output.value += (output.value ? '\n' : '') + message.text; }
  });
  cancel.onclick = async () => { cancel.disabled = true; status.textContent = 'Отменяем распознавание…'; try { await host.speechCancel(id); } catch (error) { if (!disposed) status.textContent = error.message; } };
  run.onclick = async () => {
    if (busy || configuring || disposed) return;
    if (!config?.python || !config?.model) { details.open = true; status.textContent = 'Сначала выберите Python и скачанную модель.'; return; }
    id = crypto.randomUUID(); lock(true); cancel.disabled = false; output.value = ''; output.hidden = copy.hidden = true;
    status.textContent = 'Запускаем локальный Whisper…';
    try {
      const result = await host.speechRun({ id, name: file.name || context.imageRecord?.name, url: file.omniNativeUrl || context.imageRecord?.nativeUrl || null });
      if (disposed) return;
      if (!result) { status.textContent = 'Выбор исходной записи отменён.'; return; }
      output.value = result.text; output.hidden = !result.text; copy.hidden = !result.text;
      status.textContent = result.message;
    } catch (error) { if (!disposed) { status.textContent = error.message || 'Не удалось распознать речь.'; copy.hidden = !output.value; } }
    finally { if (!disposed) lock(false); id = null; }
  };
  run.disabled = true;
  host.speechSettings().then(value => { if (!disposed) { config = value; updateSettings(); run.disabled = false; status.textContent = 'Русский язык · локально · CPU'; } }).catch(error => { if (!disposed) { run.disabled = false; status.textContent = error.message; } });
  context.signal.addEventListener('abort', () => { disposed = true; off(); if (busy && id) void host.speechCancel(id).catch(() => {}); }, { once: true });
}
