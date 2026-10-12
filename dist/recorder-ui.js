import { mountTranscripts } from './recorder-transcripts.js';
import { mountVoiceDataset } from './recorder-dataset.js';
import { mountVoiceAssistant } from './recorder-assistant.js';

/** Desktop-only microphone controls. Closing the panel never changes recording. */
export function mountRecorder(api = window.omniDesktop) {
  if (!api?.recorderStart) return;
  document.body.classList.add('desktop-recorder');
  const settingsButton = document.createElement('button');
  settingsButton.type = 'button'; settingsButton.textContent = 'Настройки микрофона';
  settingsButton.id = 'recorder-settings-button';
  const sidebar = document.querySelector('.sidebar');
  const fileHeading = sidebar?.querySelector('.list-heading');
  if (fileHeading) fileHeading.before(settingsButton); else sidebar?.append(settingsButton);
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg><span>Начать запись</span>';
  launcher.id = 'recorder-launcher';
  (sidebar?.querySelector('.sidebar-bottom') || sidebar)?.append(launcher);
  const launcherStatus = document.createElement('small');
  launcherStatus.id = 'recorder-launcher-status'; launcherStatus.setAttribute('role', 'status');
  launcher.after(launcherStatus);
  const asrStatus = document.createElement('small');
  asrStatus.id = 'recorder-asr-status'; asrStatus.hidden = true;
  launcherStatus.after(asrStatus);
  const panel = document.createElement('dialog');
  panel.id = 'recorder-panel'; panel.setAttribute('aria-labelledby', 'recorder-title');
  panel.innerHTML = `<div class="recorder-heading"><h2 id="recorder-title">Настройки микрофона</h2><button type="button" data-action="close" aria-label="Закрыть панель">×</button></div>
    <p>Silero отделяет речь от тишины и сохраняет фрагменты WAV на компьютере. Реагирует на любой голос.</p>
    <p data-status role="status" aria-live="polite">Микрофон выключен.</p>
    <div class="recorder-actions"><button type="button" data-action="start">Начать запись</button><button type="button" data-action="stop" disabled>Остановить запись</button><button type="button" data-action="hide" disabled>Свернуть в трей</button></div>
    <p data-count>Фрагментов в сеансе: 0</p>
    <fieldset class="recorder-auto"><legend>Распознавание</legend><label class="recorder-switch"><input name="auto_transcribe" type="checkbox">Автоматически распознавать новые записи</label><small>Используются локальные Python и модель из настроек Whisper. Выключение переключателя действует на новые фрагменты; существующая очередь продолжает работу.</small></fieldset>
    <fieldset class="recorder-silence"><legend>Закончить фрагмент после тишины</legend>
      <div class="recorder-presets">${[3,5,8,12].map(seconds => `<button type="button" data-silence="${seconds * 1000}" aria-pressed="false">${seconds} с</button>`).join('')}</div>
      <label>Своя пауза, мс<input name="silence_ms" type="number" min="200" max="12000" step="1" value="5000"></label>
      <small>Применяется сразу, в том числе во время записи.</small>
    </fieldset>
    <div class="recorder-settings">
      <label class="recorder-switch"><input name="enhance" type="checkbox" checked>Создавать очищенную копию WAV</label>
      <label class="recorder-switch"><input name="normalize" type="checkbox">Выравнивать громкость копии (до +6 дБ)</label>
      <p class="recorder-wide">Оригинал сохраняется всегда. Копии — в подпапке clean. Очистка уменьшает низкочастотный гул и стабильный фоновый шум.</p>
      <label>Микрофон<select name="device"><option value="">Системный по умолчанию</option></select></label>
      <button type="button" data-action="devices">Обновить микрофоны</button>
      <label>Порог речи (0,1–0,95)<input name="threshold" type="number" min="0.1" max="0.95" step="0.05" value="0.5"></label>
      <label>Звук перед началом речи, мс<input name="pre_ms" type="number" min="0" max="2000" step="1" value="1024"></label>
      <label>Максимум одного фрагмента, с<input name="max_seconds" type="number" min="30" max="600" step="1" value="600"></label>
      <label>Лимит записей, МБ<input name="quota_mb" type="number" min="100" max="10000" step="1" value="500"></label>
      <button type="button" data-action="save">Сохранить настройки</button>
      <div class="recorder-path"><strong>Python диктофона</strong><span data-python></span><button type="button" data-action="python">Выбрать Python</button></div>
      <div class="recorder-path"><strong>Папка записей</strong><span data-folder></span><button type="button" data-action="folder">Изменить папку</button></div>
    </div>
    <p>Первый запуск: выполните SETUP_VOICE_WINDOWS.ps1 из проекта. Окружение Whisper останется прежним. Закрытие окна при записи сворачивает Omni в трей; «Выйти из Omni» останавливает микрофон.</p>
    <button type="button" data-action="open-folder">Открыть папку записей</button>
    <ul data-recent aria-label="Последние фрагменты"></ul><p data-warning role="status"></p><p data-error role="alert"></p>`;
  document.body.append(panel);
  const indicator = document.createElement('div'); indicator.id = 'recorder-indicator'; indicator.hidden = true;
  indicator.innerHTML = '<button type="button" data-open>● Микрофон включён</button><button type="button" data-stop>Стоп</button>';
  document.body.append(indicator);
  const find = selector => panel.querySelector(selector);
  let state = { active: false, phase: 'stopped', clips: 0, seconds: 0, recent: [] }, busy = false, loaded = false;
  const numeric = ['threshold','silence_ms','quota_mb','pre_ms','max_seconds'];
  function render(next = state) {
    if (next.silence_ms !== undefined && next.silence_ms !== state.silence_ms) find('[name="silence_ms"]').value = next.silence_ms;
    if (next.auto_transcribe !== undefined && next.auto_transcribe !== state.auto_transcribe) find('[name="auto_transcribe"]').checked = next.auto_transcribe;
    state = next;
    find('[data-status]').textContent = state.message || 'Микрофон выключен.';
    find('[data-count]').textContent = `В сеансе: ${state.clips || 0} фрагм. · ${(state.seconds || 0).toFixed(1)} с · Занято: ${state.used_mb ?? 0} МБ`;
    find('[data-warning]').textContent = state.warning || '';
    indicator.hidden = !state.active;
    indicator.querySelector('[data-open]').textContent = state.phase === 'speech' ? '● Записывается речь' : state.phase === 'starting' ? '● Запуск микрофона' : state.phase === 'stopping' ? '● Остановка…' : '● Микрофон включён';
    indicator.querySelector('[data-stop]').disabled = state.phase === 'stopping';
    launcher.querySelector('span').textContent = state.phase === 'stopping' ? 'Сохранение…' : state.active ? 'Остановить запись' : 'Начать запись';
    launcher.setAttribute('aria-pressed', String(state.active));
    launcherStatus.textContent = state.message || 'Микрофон выключен.';
    launcher.disabled = state.phase === 'stopping' || (busy && !state.active);
    for (const element of panel.querySelectorAll('.recorder-settings input, .recorder-settings select, .recorder-settings button, [data-action="start"]')) element.disabled = busy || state.active || !loaded;
    find('[data-action="stop"]').disabled = !state.active || state.phase === 'stopping';
    find('[data-action="hide"]').disabled = !state.active;
    for (const element of panel.querySelectorAll('.recorder-silence button, .recorder-silence input')) element.disabled = busy || !loaded || state.phase === 'stopping';
    for (const button of panel.querySelectorAll('[data-silence]')) button.setAttribute('aria-pressed', String(Number(button.dataset.silence) === Number(find('[name="silence_ms"]').value)));
    find('[name="normalize"]').disabled ||= !find('[name="enhance"]').checked;
    find('[name="auto_transcribe"]').disabled = busy || !loaded;
    const list = find('[data-recent]'); list.replaceChildren();
    for (const clip of state.recent || []) {
      const item = document.createElement('li'); item.textContent = `${clip.duration.toFixed(1)} с · ${clip.path}${clip.cleanPath ? ' · очищенная копия готова' : ''}`; list.append(item);
    }
  }
  function fill(config) {
    const value = { pre_ms:1024, max_seconds:600, enhance:true, normalize:false, auto_transcribe:false, ...config };
    for (const key of numeric) find(`[name="${key}"]`).value = value[key];
    for (const key of ['enhance','normalize','auto_transcribe']) find(`[name="${key}"]`).checked = value[key];
    const select = find('[name="device"]');
    if (![...select.options].some(option => option.value === config.device)) select.add(new Option(config.device, config.device));
    select.value = config.device;
    find('[data-python]').textContent = config.python;
    find('[data-folder]').textContent = config.folder;
    loaded = true;
  }
  function read() {
    const value = { device: find('[name="device"]').value };
    for (const key of numeric) {
      const input = find(`[name="${key}"]`);
      if (!input.reportValidity()) throw new Error('Проверьте настройки диктофона.');
      value[key] = Number(input.value);
    }
    for (const key of ['enhance','normalize','auto_transcribe']) value[key] = find(`[name="${key}"]`).checked;
    return value;
  }
  async function operation(action) {
    if (busy) return;
    busy = true; find('[data-error]').textContent = ''; render();
    try { await action(); } catch (error) {
      find('[data-error]').textContent = error.message;
      if (!panel.open) panel.showModal();
    }
    finally { busy = false; render(); }
  }
  async function open() {
    if (!panel.open) panel.showModal();
    await operation(async () => { fill(await api.recorderSettings()); render(await api.recorderStatus()); });
  }
  const stop = async () => { try { render(await api.recorderStop()); } catch (error) { find('[data-error]').textContent = error.message; } };
  launcher.addEventListener('click', () => {
    if (state.active) void stop();
    else void operation(async () => { render(await api.recorderStart()); });
  });
  settingsButton.addEventListener('click', open);
  indicator.querySelector('[data-open]').addEventListener('click', open);
  indicator.querySelector('[data-stop]').addEventListener('click', stop);
  panel.addEventListener('click', event => {
    const preset = event.target.closest('[data-silence]');
    if (preset) { find('[name="silence_ms"]').value = preset.dataset.silence; void saveSilence(); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'close') panel.close();
    else if (action === 'stop') void stop();
    else if (action === 'hide') void operation(() => api.recorderHide());
    else if (action === 'start') void operation(async () => { await api.recorderSave(read()); render(await api.recorderStart()); });
    else if (action === 'save') void operation(async () => { fill(await api.recorderSave(read())); });
    else if (action === 'open-folder') void operation(() => api.recorderFolder());
    else if (action === 'python' || action === 'folder') void operation(async () => {
      await api.recorderSave(read());
      const config = await api.recorderChoose(action); if (config) fill(config);
    });
    else if (action === 'devices') void operation(async () => {
      const devices = await api.recorderDevices(), select = find('[name="device"]'), selected = select.value;
      select.replaceChildren(new Option('Системный по умолчанию', ''));
      for (const device of devices) select.add(new Option(`${device.name} (${device.host})`, device.key));
      if (selected && !devices.some(device => device.key === selected)) select.add(new Option('Недоступен: ' + selected, selected));
      select.value = selected;
    });
  });
  async function saveSilence() {
    const input = find('[name="silence_ms"]');
    if (!input.reportValidity()) return;
    await operation(async () => {
      const config = await api.recorderSilence(Number(input.value));
      input.value = config.silence_ms;
    });
  }
  find('[name="silence_ms"]').addEventListener('change', () => void saveSilence());
  find('[name="enhance"]').addEventListener('change', () => render());
  find('[name="auto_transcribe"]').addEventListener('change', () => void operation(async () => {
    const config = await api.recorderAuto(find('[name="auto_transcribe"]').checked);
    find('[name="auto_transcribe"]').checked = config.auto_transcribe;
  }));
  mountTranscripts(panel, api, operation, queue => {
    asrStatus.hidden = !queue.busy && !queue.problem;
    asrStatus.textContent = queue.problem || `Whisper: в очереди и обработке ${queue.pending} фрагм.`;
  });
  const dataset = mountVoiceDataset(panel, api);
  if (dataset) {
    const datasetButton = document.createElement('button'); datasetButton.type = 'button';
    datasetButton.textContent = 'Мой голос и датасет'; datasetButton.id = 'recorder-dataset-button';
    settingsButton.after(datasetButton);
    datasetButton.addEventListener('click', async () => { await open(); dataset.section.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  }
  const assistant = mountVoiceAssistant(panel, api);
  if (assistant) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = 'Голосовые команды и напоминания'; button.id = 'recorder-assistant-button';
    (document.querySelector('#recorder-dataset-button') || settingsButton).after(button);
    button.addEventListener('click', async () => { await open(); await assistant.refresh(); assistant.section.scrollIntoView({ block:'start', behavior:'smooth' }); });
  }
  // Do not let reader shortcuts change a document while this panel has focus.
  panel.addEventListener('keydown', event => event.stopPropagation());
  const unsubscribe = api.onRecorderState(render);
  window.addEventListener('pagehide', unsubscribe, { once: true });
  void api.recorderStatus().then(render).catch(() => {});
  return { panel, launcher, indicator, settingsButton };
}
if (typeof window !== 'undefined') mountRecorder();
