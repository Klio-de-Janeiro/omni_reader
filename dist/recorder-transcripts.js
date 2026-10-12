import { createSpeechOptions } from './speech-options-ui.js';

const titles = { queued:'В очереди', running:'Распознаётся', done:'Готово', empty:'Речь не обнаружена', error:'Ошибка', cancelled:'Отменено', not_requested:'Не распознавалось' };

/** Show the desktop queue, inline transcripts and the shared Whisper settings. */
export function mountTranscripts(container, api, operation, onState = () => {}) {
  if (!api?.voiceTranscripts) return;
  const section = document.createElement('section'); section.className = 'recorder-transcripts';
  section.innerHTML = `<h3>Распознавание записей · Whisper</h3>
    <p data-queue-status role="status" aria-live="polite"></p>
    <p data-queue-problem role="alert"></p>
    <button type="button" data-resume hidden>Продолжить очередь</button>
    <button type="button" data-pause hidden>Приостановить очередь</button>
    <p class="speech-note">Запись продолжается во время распознавания. Остановка микрофона сохраняет последний фрагмент; Whisper завершает очередь.</p>
    <ul data-transcript-list aria-label="История распознавания"></ul>
    <div data-text-view hidden><strong data-text-title></strong><textarea data-text-output readonly aria-label="Распознанная речь"></textarea><p data-text-path></p></div>
    <details data-whisper-settings><summary>Настройки Whisper</summary>
      <p class="speech-note">Общие с распознаванием открытых WAV/OGG. В автоматическом режиме значение «0 потоков» использует 4 потока CPU.</p>
      <div class="recorder-path"><strong>Python Whisper</strong><span data-whisper-python></span><button type="button" data-whisper-choose="python">Выбрать Python</button></div>
      <div class="recorder-path"><strong>Модель</strong><span data-whisper-model></span><div class="recorder-actions"><button type="button" data-whisper-choose="model-folder">Папка faster-whisper</button><button type="button" data-whisper-choose="model-file">Модель .pt</button></div></div>
      <div class="recorder-path"><strong>FFmpeg для .pt</strong><span data-whisper-ffmpeg></span><button type="button" data-whisper-choose="ffmpeg">Выбрать FFmpeg</button></div>
      <div data-whisper-parameters></div><button type="button" data-whisper-save>Сохранить параметры Whisper</button><p data-whisper-status role="status"></p>
    </details>`;
  container.append(section);
  const find = selector => section.querySelector(selector);
  let form, config, dirty = false, editing = false, loaded = false, selected = null, version = 0;
  function settings(next) {
    config = next;
    find('[data-whisper-python]').textContent = next.python;
    find('[data-whisper-model]').textContent = next.model;
    find('[data-whisper-ffmpeg]').textContent = next.ffmpeg || 'Не выбран';
    if (!form) form = createSpeechOptions(find('[data-whisper-parameters]'), next.schema, () => { dirty = true; });
    if (!dirty) form.set(next.params, next.model); else form.setModel(next.model);
    loaded = true;
  }
  async function change(action) {
    if (editing) return;
    editing = true; find('[data-whisper-status]').textContent = '';
    form?.lock(true);
    try { const next = await action(); if (next) settings(next); find('[data-whisper-status]').textContent = dirty ? 'Путь сохранён. Параметры ещё не сохранены.' : 'Настройки сохранены.'; }
    catch (error) { find('[data-whisper-status]').textContent = error.message; }
    finally { editing = false; form?.lock(false); }
  }
  find('[data-whisper-settings]').addEventListener('toggle', () => {
    if (find('[data-whisper-settings]').open && !loaded) void change(async () => api.speechSettings());
  });
  find('[data-whisper-save]').addEventListener('click', () => {
    if (!form) return;
    void change(async () => { const next = await api.speechSave(form.read()); dirty = false; return next; });
  });
  for (const button of section.querySelectorAll('[data-whisper-choose]')) button.addEventListener('click', () => void change(() => api.speechChoose(button.dataset.whisperChoose)));
  async function showText(id) {
    const ticket = ++version; selected = id;
    const result = await api.voiceText(id);
    if (ticket !== version) return;
    find('[data-text-view]').hidden = false;
    find('[data-text-title]').textContent = 'Распознанная речь';
    find('[data-text-output]').value = result.text;
    find('[data-text-path]').textContent = result.savedPath || 'Текст пока не сохранён.';
  }
  function render(state) {
    onState(state);
    find('[data-queue-status]').textContent = `В очереди и обработке: ${state.pending} из ${state.limit || 24}${state.paused ? ' · приостановлено' : state.busy ? ' · Whisper работает' : ''}`;
    find('[data-queue-problem]').textContent = state.problem || '';
    find('[data-resume]').hidden = !state.paused;
    find('[data-pause]').hidden = state.paused || !state.pending;
    const list = find('[data-transcript-list]'); list.replaceChildren();
    for (const item of (state.items || []).slice(0, 30)) {
      const row = document.createElement('li'), heading = document.createElement('strong'), message = document.createElement('p');
      heading.textContent = `${titles[item.status] || item.status} · ${Number(item.duration).toFixed(1)} с`;
      message.textContent = item.message || ''; row.append(heading, message);
      const source = document.createElement('small'); source.textContent = item.path; row.append(source);
      const actions = document.createElement('div'); actions.className = 'recorder-actions';
      const button = (label, action) => {
        const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
        node.addEventListener('click', () => void operation(action)); actions.append(node);
      };
      if (item.savedPath || item.preview) button('Показать текст', () => showText(item.id));
      if (['queued','running'].includes(item.status)) button('Отменить распознавание', async () => render(await api.voiceCancel(item.id)));
      else button(item.status === 'done' ? 'Распознать снова' : item.status === 'not_requested' ? 'Распознать' : 'Повторить', async () => render(await api.voiceRetry(item.id)));
      row.append(actions); list.append(row);
      if (selected === item.id && !item.savedPath) find('[data-text-output]').value = item.preview || '';
    }
    if (!list.children.length) { const empty = document.createElement('li'); empty.textContent = 'Здесь появятся новые записи диктофона.'; list.append(empty); }
  }
  find('[data-resume]').addEventListener('click', () => void operation(async () => render(await api.voiceResume())));
  find('[data-pause]').addEventListener('click', () => void operation(async () => render(await api.voicePause())));
  const off = api.onVoiceTranscripts(render);
  window.addEventListener('pagehide', off, { once: true });
  void api.voiceTranscripts().then(render).catch(error => { find('[data-queue-problem]').textContent = error.message; });
  return { render, section };
}
