const roles = { candidate: 'Фрагмент для датасета', reference: 'Эталон · мой голос', calibration_owner: 'Калибровка · мой голос', calibration_other: 'Калибровка · чужой голос', test_owner: 'Отдельный тест · мой голос', test_other: 'Отдельный тест · чужой голос' };
const outcomes = { owner: 'Похож на мой голос', other: 'Не похож на мой голос', uncertain: 'Нужна ручная проверка' };
const percent = value => value === null ? '—' : (value * 100).toFixed(1) + '%';

/** Review local recordings without changing microphone or original ASR files. */
export function mountVoiceDataset(container, api) {
  if (!api?.voiceDatasetStatus) return;
  const section = document.createElement('section'); section.className = 'recorder-dataset';
  section.innerHTML = `<h3>Мой голос и датасет</h3>
    <p>Запишите минимум 3 эталона своего голоса: суммарно 15 секунд речи. Для калибровки нужны ещё 3 свои и 3 чужие записи. Для проверки ошибок отметьте отдельные тестовые записи, которые не использовались в калибровке.</p>
    <div class="recorder-actions"><button type="button" data-dataset="record">Записать эталоны</button><button type="button" data-reference-stop hidden>Закончить запись эталонов</button><button type="button" data-dataset="import">Добавить WAV</button></div>
    <p data-enrollment role="status"></p>
    <details data-speaker-settings><summary>Локальная speaker-модель</summary>
      <p>Первый запуск: SETUP_SPEAKER_WINDOWS.ps1. WeSpeaker работает на CPU, один поток. Модель и звук остаются на компьютере.</p>
      <div class="recorder-path"><strong>Python проверки голоса</strong><span data-speaker-python></span><button type="button" data-dataset="python">Выбрать Python</button></div>
      <div class="recorder-path"><strong>Модель ONNX</strong><span data-speaker-model></span><button type="button" data-dataset="model">Выбрать модель</button></div>
    </details>
    <div class="recorder-actions"><button type="button" data-dataset="calibrate">Калибровать по отмеченным записям</button><button type="button" data-dataset="evaluate">Измерить ошибки на отдельном тесте</button><button type="button" data-check-cancel hidden>Отменить проверку</button></div>
    <label class="recorder-switch"><input type="checkbox" data-speaker-auto>Проверять голос в новых фрагментах после калибровки</label>
    <p data-profile-status></p><p data-calibration-status></p><p data-evaluation-status></p>
    <p data-dataset-status role="status" aria-live="polite"></p><p data-dataset-error role="alert"></p>
    <div class="dataset-filters"><label>Показать<select data-dataset-filter><option value="all">Все записи</option><option value="pending">Ожидают отбора</option><option value="approved">Подтверждены для экспорта</option>${Object.entries(roles).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><span data-dataset-count></span></div>
    <ul data-dataset-list aria-label="Записи для проверки голоса и датасета"></ul>
    <div class="recorder-actions"><button type="button" data-page-prev>Назад</button><span data-page-number></span><button type="button" data-page-next>Далее</button></div>
    <div data-dataset-review hidden><h4 data-review-title></h4><p data-review-path></p><audio data-review-audio controls preload="metadata"></audio>
      <label>Назначение записи<select data-review-role>${Object.entries(roles).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
      <p data-review-result></p><p data-review-error role="alert"></p>
      <label>Текст записи<textarea data-review-text spellcheck="true" placeholder="Распознайте запись Whisper или введите текст вручную."></textarea></label>
      <label class="recorder-switch"><input type="checkbox" data-review-confirm>Текст прослушан и проверен</label>
      <div class="recorder-actions"><button type="button" data-dataset="recognize">Распознать Whisper</button><button type="button" data-dataset="original">Взять свежий текст Whisper</button><button type="button" data-dataset="verify">Проверить голос</button><button type="button" data-dataset="save">Сохранить текст и назначение</button><button type="button" data-dataset="approve">Подтвердить мой голос для датасета</button><button type="button" data-dataset="reject">Исключить из датасета</button><button type="button" data-dataset="reload">Перечитать запись</button></div>
      <small>Подтверждение означает, что вы прослушали запись своего голоса. Сомнительные и короткие фрагменты проверяются вручную. «Перечитать запись» сбрасывает несохранённый черновик этой записи.</small>
    </div>
    <div class="recorder-actions"><button type="button" data-dataset="export">Экспорт WAV + JSONL + TXT</button></div>
    <p>Экспортируются только вручную подтверждённые фрагменты с проверенным текстом. Эталоны и записи оценки остаются отдельно. Исправления не меняют оригинальный WAV и текст Whisper.</p>`;
  container.append(section);
  const find = selector => section.querySelector(selector);
  const drafts = new Map();
  let state = { config: {}, roles: {} }, working = false, selected = null, offset = 0, total = 0, listVersion = 0, detailVersion = 0, audioUrl = null, micActive = false, destroyed = false;
  function revokeAudio() {
    const audio = find('[data-review-audio]'); audio.pause(); audio.removeAttribute('src'); audio.load();
    if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = null;
  }
  function remember() {
    if (!selected) return;
    drafts.set(selected.item.id, { revision: selected.revision, text: find('[data-review-text]').value, role: find('[data-review-role]').value, text_confirmed: find('[data-review-confirm]').checked });
  }
  function lock() {
    const busy = working || state.processing;
    for (const button of section.querySelectorAll('[data-dataset]')) button.disabled = busy || (['verify', 'recognize', 'original', 'save', 'approve', 'reject', 'reload'].includes(button.dataset.dataset) && !selected);
    find('[data-dataset="record"]').disabled ||= micActive;
    find('[data-dataset="approve"]').disabled ||= find('[data-review-role]').value !== 'candidate';
    for (const input of section.querySelectorAll('[data-review-role], [data-review-text], [data-review-confirm]')) input.disabled = busy;
    for (const button of section.querySelectorAll('[data-dataset-list] button')) button.disabled = busy;
    find('[data-speaker-auto]').disabled = working || !state.calibration;
    find('[data-check-cancel]').hidden = !state.processing && !state.pending;
    find('[data-reference-stop]').hidden = !state.enrollment;
    find('[data-page-prev]').disabled = offset === 0;
    find('[data-page-next]').disabled = offset + 30 >= total;
  }
  async function operation(action) {
    if (working) return;
    working = true; find('[data-dataset-error]').textContent = ''; lock();
    try { await action(); }
    catch (error) { find('[data-dataset-error]').textContent = error.message; }
    finally { working = false; lock(); }
  }
  async function loadList() {
    const ticket = ++listVersion;
    const page = await api.voiceDatasetList({ offset, limit: 30, filter: find('[data-dataset-filter]').value });
    if (ticket !== listVersion || destroyed) return;
    total = page.total;
    if (offset >= total && offset > 0) { offset = Math.max(0, Math.floor((total - 1) / 30) * 30); return loadList(); }
    const list = find('[data-dataset-list]'); list.replaceChildren();
    for (const item of page.items) {
      const row = document.createElement('li'), title = document.createElement('strong'), info = document.createElement('p'), button = document.createElement('button');
      title.textContent = `${roles[item.role]} · ${Number(item.duration).toFixed(1)} с`;
      info.textContent = `${outcomes[item.decision] || outcomes.uncertain}${item.review === 'approved' ? ' · подтверждено вручную' : item.review === 'rejected' ? ' · исключено' : ''}${item.analysis_error ? ' · ' + item.analysis_error : ''}`;
      button.type = 'button'; button.textContent = 'Прослушать и отобрать'; button.disabled = working || state.processing;
      button.addEventListener('click', () => void operation(() => select(item.id)));
      if (selected?.item.id === item.id) row.setAttribute('aria-current', 'true');
      row.append(title, info, button); list.append(row);
    }
    if (!page.items.length) { const empty = document.createElement('li'); empty.textContent = 'Запишите речь диктофоном или добавьте WAV.'; list.append(empty); }
    find('[data-page-number]').textContent = total ? `${offset + 1}–${Math.min(offset + 30, total)} из ${total}` : 'Нет записей'; lock();
  }
  async function select(id, fresh = false) {
    if (fresh) drafts.delete(id); else remember();
    const ticket = ++detailVersion;
    const detail = await api.voiceDatasetDetail(id);
    const bytes = await api.voiceDatasetAudio(id);
    if (ticket !== detailVersion || destroyed) return;
    revokeAudio(); selected = detail;
    audioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); find('[data-review-audio]').src = audioUrl;
    const draft = drafts.get(id), serverRevision = detail.revision;
    find('[data-dataset-review]').hidden = false;
    find('[data-review-title]').textContent = 'Запись · ' + Number(detail.item.duration).toFixed(1) + ' с';
    find('[data-review-path]').textContent = detail.item.path;
    find('[data-review-role]').value = draft?.role ?? detail.item.role;
    find('[data-review-text]').value = draft?.text ?? detail.text;
    find('[data-review-confirm]').checked = draft?.text_confirmed ?? detail.text_confirmed;
    if (draft) selected.revision = draft.revision;
    find('[data-review-result]').textContent = `${outcomes[detail.item.decision] || outcomes.uncertain}${detail.item.check?.scores?.length ? ' · сходство ' + detail.item.check.scores.map(value => value.toFixed(3)).join(' / ') : ''}${detail.speech_seconds !== null ? ' · речи ' + detail.speech_seconds.toFixed(1) + ' с' : ''}${detail.item.check?.reason ? ' · ' + detail.item.check.reason : ''}`;
    find('[data-review-error]').textContent = draft && draft.revision !== serverRevision ? 'Запись изменена в другом окне. Ваш черновик сохранён; перечитайте запись перед новым отбором.' : detail.text_problem || '';
    lock();
  }
  function render(next) {
    if (destroyed) return;
    state = next;
    find('[data-speaker-python]').textContent = next.config?.python || '';
    find('[data-speaker-model]').textContent = next.config?.model || '';
    find('[data-speaker-auto]').checked = !!next.config?.auto_verify;
    find('[data-profile-status]').textContent = `Эталоны: ${next.roles?.reference || 0} · Калибровка: свои ${next.roles?.calibration_owner || 0}, чужие ${next.roles?.calibration_other || 0} · Подтверждены для экспорта: ${next.approved || 0}`;
    find('[data-enrollment]').textContent = next.enrollment ? 'Записываются эталоны вашего голоса. Произнесите несколько разных фраз, делая выбранную паузу между ними. Завершите запись перед калибровкой.' : '';
    find('[data-calibration-status]').textContent = next.calibration ? `Калибровка сохранена: отклонить ≤ ${next.calibration.thresholds.reject.toFixed(3)}, принять ≥ ${next.calibration.thresholds.accept.toFixed(3)}. Между порогами — ручная проверка.` : 'Калибровка ещё не выполнена. Модель не подтверждает владельца без неё.';
    const test = next.evaluation;
    find('[data-evaluation-status]').textContent = test ? `Отдельный тест: чужой голос принят ${test.false_accepts}/${test.other_count} (${percent(test.far)}); свой отклонён ${test.false_rejects}/${test.owner_count} (${percent(test.frr)}). Нужна ручная проверка: свои ${test.owner_uncertain}, чужие ${test.other_uncertain}. Это результаты только этих ${test.owner_count + test.other_count} записей.` : 'Ошибки на отдельных тестовых записях ещё не измерены.';
    find('[data-dataset-status]').textContent = next.message || (next.pending ? `В очереди проверки голоса: ${next.pending}${next.paused ? ' · приостановлено; повторите проверку вручную' : ''}` : 'Готово к отбору записей.');
    if (next.problem) find('[data-dataset-error]').textContent = next.problem;
    find('[data-dataset-count]').textContent = `Всего: ${next.total || 0} / ${next.limit || 5000}`;
    lock(); void loadList().catch(error => { find('[data-dataset-error]').textContent = error.message; });
  }
  async function save(review) {
    const id = selected.item.id;
    const result = await api.voiceDatasetReview(id, { revision: selected.revision, role: review === 'rejected' ? 'candidate' : find('[data-review-role]').value,
      review, text: find('[data-review-text]').value, text_confirmed: find('[data-review-confirm]').checked });
    drafts.delete(id); selected = null; await select(id, true);
    find('[data-review-error]').textContent = review === 'approved' ? 'Запись подтверждена для экспорта.' : review === 'rejected' ? 'Запись исключена. Оригинал сохранён.' : 'Текст и назначение сохранены.';
    return result;
  }
  section.addEventListener('click', event => {
    const action = event.target.closest('[data-dataset]')?.dataset.dataset;
    if (!action) return;
    void operation(async () => {
      if (action === 'record') await api.voiceRecordReference();
      else if (action === 'import') { await api.voiceDatasetImport(); await loadList(); }
      else if (action === 'python' || action === 'model') { const value = await api.voiceDatasetChoose(action); if (value) render(value); }
      else if (action === 'calibrate' || action === 'evaluate') render(await api.voiceDatasetAnalyze(action));
      else if (action === 'verify') { await api.voiceDatasetAnalyze('verify', selected.item.id); await select(selected.item.id); }
      else if (action === 'recognize') { await api.voiceDatasetRecognize(selected.item.id); find('[data-review-error]').textContent = 'Запись отправлена в Whisper. После завершения нажмите «Взять свежий текст Whisper».'; }
      else if (action === 'original') { const detail = await api.voiceDatasetDetail(selected.item.id); find('[data-review-text]').value = detail.original_text; find('[data-review-confirm]').checked = false; remember(); }
      else if (action === 'save') await save('pending');
      else if (action === 'approve') await save('approved');
      else if (action === 'reject') await save('rejected');
      else if (action === 'reload') { const id = selected.item.id; selected = null; await select(id, true); }
      else if (action === 'export') { const value = await api.voiceDatasetExport(); if (value) find('[data-dataset-status]').textContent = `Экспортировано ${value.count} записей: ${value.folder}`; }
    });
  });
  find('[data-review-text]').addEventListener('input', () => { find('[data-review-confirm]').checked = false; remember(); });
  for (const selector of ['[data-review-role]', '[data-review-confirm]']) find(selector).addEventListener('change', () => { remember(); lock(); });
  find('[data-speaker-auto]').addEventListener('change', () => void operation(async () => render(await api.voiceDatasetAuto(find('[data-speaker-auto]').checked))));
  find('[data-check-cancel]').addEventListener('click', () => { void api.voiceDatasetCancel().then(render).catch(error => { find('[data-dataset-error]').textContent = error.message; }); });
  find('[data-reference-stop]').addEventListener('click', () => { void api.recorderStop().catch(error => { find('[data-dataset-error]').textContent = error.message; }); });
  find('[data-dataset-filter]').addEventListener('change', () => { offset = 0; void loadList(); });
  find('[data-page-prev]').addEventListener('click', () => { offset = Math.max(0, offset - 30); void loadList(); });
  find('[data-page-next]').addEventListener('click', () => { offset += 30; void loadList(); });
  const off = api.onVoiceDataset(render), offMic = api.onRecorderState(next => { micActive = next.active; lock(); });
  container.addEventListener('close', revokeAudio);
  window.addEventListener('pagehide', () => { destroyed = true; ++detailVersion; ++listVersion; off(); offMic(); revokeAudio(); }, { once: true });
  void api.voiceDatasetStatus().then(render).catch(error => { find('[data-dataset-error]').textContent = error.message; });
  void api.recorderStatus?.().then(next => { micActive = next.active; lock(); }).catch(() => {});
  return { section, render };
}
