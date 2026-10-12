import { copyText } from './clipboard.js';
import { createSpeechOptions } from './speech-options-ui.js';

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
  const details = node('details', '', 'speech-settings'); details.append(node('summary', 'Пути и параметры Whisper'));
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
      choose.onclick = () => changeSettings(() => host.speechChoose(kind), false);
      row.append(choose);
    }
    details.append(row);
  }
  details.append(node('p', 'По умолчанию используются Python из whisper_env и твоя модель Small. Пути можно заменить. CPU · VAD выключен. Для faster-whisper FFmpeg отдельно не нужен.', 'speech-note'));
  const parameters = node('div', '', 'speech-parameters'), settingsActions = node('div', '', 'speech-actions');
  const save = button('Сохранить параметры'), reset = button('Восстановить значения по умолчанию');
  reset.title = 'Восстановить твои пути к Python и Small, а также исходные параметры';
  settingsActions.append(save, reset); details.append(parameters, settingsActions);
  const status = node('p', 'Загружаем настройки…', 'speech-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const output = node('textarea', '', 'speech-result'); output.readOnly = true; output.rows = 10; output.hidden = true; output.setAttribute('aria-label', 'Распознанная речь');
  const copy = button('Копировать текст'); copy.hidden = true;
  area.append(actions, details, status, output, copy); panel.append(area);
  let busy = false, configuring = false, loading = true, disposed = false, dirty = false, cancelRequested = false, id, config = null, form;
  function disableControls() {
    const locked = busy || configuring || loading;
    run.disabled = settings.disabled = save.disabled = reset.disabled = locked;
    for (const picker of pickers) picker.disabled = locked;
    form?.lock(locked);
  }
  function updateSettings(overwrite = false) {
    for (const [key, el] of chosen) { el.textContent = config?.[key] || 'Не выбран'; el.title = config?.[key] || ''; }
    if (!form) {
      if (!Array.isArray(config.schema)) throw new Error('Обновите файлы desktop и dist из патча настроек Whisper.');
      form = createSpeechOptions(parameters, config.schema, () => { dirty = true; status.textContent = 'Параметры изменены. Они сохранятся по кнопке «Сохранить параметры» или при запуске распознавания.'; });
    }
    if (!dirty || overwrite) { form.set(config.params, config.model); dirty = false; }
    else form.setModel(config.model);
    disableControls();
  }
  async function changeSettings(action, overwrite) {
    if (busy || configuring || loading || disposed) return;
    configuring = true; disableControls();
    try { const next = await action(); if (!disposed && next) { config = next; updateSettings(overwrite); status.textContent = dirty ? 'Путь сохранён. Изменённые параметры ещё не сохранены.' : 'Настройки сохранены.'; } }
    catch (error) { if (!disposed) status.textContent = error.message; }
    finally { configuring = false; if (!disposed) disableControls(); }
  }
  function lock(value) { busy = value; cancel.hidden = !value; disableControls(); }
  save.onclick = () => changeSettings(() => host.speechSave(form.read()), true);
  reset.onclick = () => changeSettings(() => host.speechReset(), true);
  settings.onclick = () => { details.open = !details.open; };
  copy.onclick = async () => { try { await copyText(output.value); status.textContent = 'Текст скопирован.'; } catch (error) { status.textContent = error.message; } };
  const off = host.onSpeechProgress(message => {
    if (disposed || message.id !== id) return;
    if (message.type === 'status') status.textContent = message.message;
    else if (message.type === 'segment') { output.hidden = false; output.value += (output.value ? '\n' : '') + message.text; }
  });
  cancel.onclick = async () => { cancelRequested = true; cancel.disabled = true; status.textContent = 'Отменяем распознавание…'; try { await host.speechCancel(id); } catch (error) { if (!disposed) status.textContent = error.message; } };
  run.onclick = async () => {
    if (busy || configuring || loading || disposed) return;
    if (!config?.python || !config?.model) { details.open = true; status.textContent = 'Сначала выберите Python и скачанную модель.'; return; }
    let params;
    try { params = form.read(); } catch (error) { details.open = true; status.textContent = error.message; return; }
    id = crypto.randomUUID(); cancelRequested = false; lock(true); cancel.disabled = false; output.value = ''; output.hidden = copy.hidden = true;
    status.textContent = 'Запускаем локальный Whisper…';
    try {
      config = await host.speechSave(params);
      if (disposed) return;
      updateSettings(true);
      if (cancelRequested) { status.textContent = 'Распознавание отменено.'; return; }
      const result = await host.speechRun({ id, name: file.name || context.imageRecord?.name, url: file.omniNativeUrl || context.imageRecord?.nativeUrl || null });
      if (disposed) return;
      if (!result) { status.textContent = 'Выбор исходной записи отменён.'; return; }
      output.value = result.text; output.hidden = !result.text; copy.hidden = !result.text;
      status.textContent = result.message;
    } catch (error) { if (!disposed) { status.textContent = error.message || 'Не удалось распознать речь.'; copy.hidden = !output.value; } }
    finally { if (!disposed) lock(false); id = null; }
  };
  disableControls();
  host.speechSettings().then(value => {
    if (!disposed) {
      config = value; loading = false; updateSettings();
      status.textContent = 'Локально · CPU · язык: ' + (config.params.language === 'auto' ? 'автоопределение' : config.params.language);
    }
  }).catch(error => { if (!disposed) status.textContent = error.message; });
  context.signal.addEventListener('abort', () => { disposed = true; off(); if (busy && id) void host.speechCancel(id).catch(() => {}); }, { once: true });
}
