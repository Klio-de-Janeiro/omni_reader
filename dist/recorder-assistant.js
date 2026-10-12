const labels = {
  create_reminder: 'Новое напоминание', reschedule_reminder: 'Перенести напоминание',
  complete_reminder: 'Завершить задачу', update_progress: 'Обновить прогресс',
  dataset_candidate: 'Перейти к сбору датасета', clarify: 'Нужно уточнение', ignore: 'Не команда'
};
const statuses = { queued:'В очереди', running:'Qwen обрабатывает', proposed:'Ждёт подтверждения', clarification:'Нужно уточнение', confirmed:'Сохранено', rejected:'Отклонено', error:'Ошибка', cancelled:'Отменено', ignored:'Пропущено' };
const node = (tag, text, attributes = {}) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};
const date = (value, zone) => {
  if (!value) return 'Время записи неизвестно';
  try { return new Intl.DateTimeFormat('ru-RU', { dateStyle:'short', timeStyle:'medium', timeZone:zone }).format(new Date(value)); }
  catch { return String(value); }
};

/** Desktop-only local commands. Forms retain drafts across background updates. */
export function mountVoiceAssistant(panel, api) {
  if (!api?.voiceAssistantStatus) return;
  const section = node('section', undefined, { class:'recorder-assistant', 'aria-labelledby':'voice-assistant-title' });
  section.innerHTML = `<h3 id="voice-assistant-title">Голосовые команды и напоминания</h3>
    <p>Включите автоматическое распознавание и начните запись. Обращайтесь в начале фразы: «Омни, напомни завтра в 19:00 решить задачи». Изменения сохраняются после вашего подтверждения.</p>
    <details data-assistant-settings><summary>Настройки локального Qwen</summary>
    <div class="assistant-settings">
      <label class="recorder-switch"><input name="enabled" type="checkbox">Обрабатывать новые обращения «Омни»</label>
      <label>Режим<select name="mode"><option value="commands">Голосовые команды</option><option value="dataset">Сбор датасета</option></select></label>
      <label>Локальный сервер<select name="backend"><option value="ollama">Ollama</option><option value="openai">LM Studio / совместимый API</option></select></label>
      <label>Адрес<input name="endpoint" type="url" maxlength="200" placeholder="http://127.0.0.1:11434"></label>
      <label>Установленная модель<input name="model" maxlength="160" list="omni-qwen-models"><datalist id="omni-qwen-models"></datalist></label>
      <label>Часовой пояс IANA<input name="timezone" maxlength="80" placeholder="Europe/Moscow"></label>
      <label>Таймаут, с<input name="timeout_seconds" type="number" min="30" max="1800" step="1"></label>
      <label>Потоки Qwen (Ollama)<input name="cpu_threads" type="number" min="1" max="6" step="1"></label>
      <label>Температура<input name="temperature" type="number" min="0" max="1" step="0.05"></label>
      <label class="recorder-switch"><input name="require_owner" type="checkbox">Только проверенный голос владельца</label>
    </div>
    <small>Проверка владельца требует калибровки в «Мой голос и датасет». В режиме датасета команды из записи не обрабатываются. Запуск микрофона и экспорт записей выполняются отдельно. Для LM Studio потоки задаются при загрузке модели на сервере.</small>
    <div class="recorder-actions"><button type="button" data-save-qwen>Сохранить</button><button type="button" data-models>Обновить модели</button></div>
    <p data-models-status role="status"></p><p data-database class="assistant-path"></p></details>
    <p data-assistant-state role="status" aria-live="polite"></p>
    <div class="recorder-actions"><button type="button" data-cancel-qwen>Отменить обработку Qwen</button><button type="button" data-refresh-qwen>Обновить</button></div>
    <label>Команда текстом<textarea data-command rows="3" maxlength="8192" placeholder="Омни, напомни через час сделать перерыв"></textarea></label>
    <label>Выбранная задача для голосовой или текстовой команды<select data-command-target><option value="">Не выбрана</option></select></label>
    <button type="button" data-send-command>Разобрать команду</button>
    <p data-assistant-error role="alert"></p>
    <h4>Предложения Qwen</h4><label>Показать<select data-proposal-filter><option value="all">Все</option><option value="pending">Ждут обработки / подтверждения</option><option value="error">Ошибки и отменённые</option></select></label>
    <ul data-proposals></ul><div class="recorder-actions"><button type="button" data-proposals-prev>Назад</button><span data-proposals-page></span><button type="button" data-proposals-next>Далее</button></div>
    <h4>Сохранённые напоминания</h4><p>Задачи и история прогресса сохраняются на компьютере. Доставка уведомлений — следующий этап.</p>
    <label>Состояние<select data-reminder-filter><option value="open">Открытые</option><option value="done">Завершённые</option><option value="all">Все</option></select></label>
    <ul data-reminders></ul><div class="recorder-actions"><button type="button" data-reminders-prev>Назад</button><span data-reminders-page></span><button type="button" data-reminders-next>Далее</button></div>`;
  panel.append(section);
  const find = selector => section.querySelector(selector);
  let dirty = false, busy = false, disposed = false, sequence = 0, timer;
  let proposalOffset = 0, reminderOffset = 0, proposalTotal = 0, reminderTotal = 0;
  let available = [], selected = null;
  let selectedId = null;
  const drafts = new Map();
  const fields = ['enabled','mode','backend','endpoint','model','timezone','timeout_seconds','cpu_threads','temperature','require_owner'];
  function renderState(next) {
    selectedId = next.selected_reminder_id || null;
    find('[data-assistant-state]').textContent = next.problem || `${next.message} В очереди: ${next.pending}.`;
    find('[data-database]').textContent = 'База: ' + next.database;
    find('[data-cancel-qwen]').disabled = !next.busy;
    if (!dirty) for (const key of fields) {
      const input = find(`[name="${key}"]`);
      if (input.type === 'checkbox') input.checked = !!next.config[key]; else input.value = next.config[key];
    }
  }
  function readSettings() {
    return Object.fromEntries(fields.map(key => {
      const input = find(`[name="${key}"]`);
      return [key, input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim()];
    }));
  }
  async function operation(action) {
    if (busy || disposed) return;
    busy = true; find('[data-assistant-error]').textContent = '';
    for (const button of section.querySelectorAll('[data-save-qwen],[data-models],[data-send-command],[data-command-target],[data-target-choice]')) button.disabled = true;
    try { await action(); await refresh(); }
    catch (error) { find('[data-assistant-error]').textContent = error.message; }
    finally {
      busy = false;
      for (const button of section.querySelectorAll('[data-save-qwen],[data-models],[data-send-command],[data-command-target],[data-target-choice]')) button.disabled = false;
    }
  }
  function options(select, current = '') {
    select.replaceChildren(new Option('Выберите задачу', ''));
    const rows = selected && !available.some(item => item.id === selected.id) ? [selected, ...available] : available;
    for (const item of rows) if (item.status === 'open') select.add(new Option(item.title, item.id));
    if (current && !rows.some(item => item.id === current)) select.add(new Option('Задача недоступна; выберите повторно', current));
    select.value = current;
  }
  function card(row) {
    const li = node('li', undefined, { 'data-proposal-id':row.id });
    const intent = row.intent || {};
    li.append(node('strong', labels[intent.type] || 'Обращение «Омни»'), node('p', `${statuses[row.status] || row.status} · ${date(row.spoken_at, row.timezone)} · ${row.timezone}`), node('pre', row.text), node('p', row.message));
    const button = (text, action) => {
      const value = node('button', text, { type:'button' });
      value.addEventListener('click', () => void operation(action)); li.append(value); return value;
    };
    if (['error','cancelled'].includes(row.status)) button('Повторить', () => api.voiceAssistantRetry(row.id));
    if (['proposed','clarification'].includes(row.status)) {
      const actionable = ['create_reminder','reschedule_reminder','complete_reminder','update_progress','dataset_candidate'].includes(intent.type);
      let draft = drafts.get(row.id);
      if (!draft) {
        draft = { revision:row.revision, title:intent.title || '', due_local:intent.due_local || '', timezone:row.timezone,
          reminder_id:intent.reminder_id || '', target_revision:intent.target_revision, progress_current:intent.progress_current, progress_total:intent.progress_total };
        drafts.set(row.id, draft);
      }
      if (draft.revision !== row.revision) {
        li.append(node('p', 'Карточка изменилась в другом окне. Ваш черновик сохранён; загрузите новую карточку перед подтверждением.'));
        button('Загрузить новую карточку', async () => { drafts.delete(row.id); });
      }
      const form = node('form'); li.append(form);
      function field(key, text, type = 'text') {
        const label = node('label', text), input = node('input', undefined, { type, 'data-draft-field':key, 'aria-label':text });
        input.value = draft[key] ?? ''; input.required = true;
        if (key === 'title') input.maxLength = 240;
        if (type === 'datetime-local') input.step = '1';
        if (type === 'number') { input.min = key === 'progress_total' ? '1' : '0'; input.max = '1000000'; input.step = '1'; }
        input.addEventListener('input', () => { draft[key] = type === 'number' ? input.value === '' ? null : Number(input.value) : input.value; });
        label.append(input); form.append(label);
      }
      if (intent.type === 'create_reminder') field('title', 'Название задачи');
      if (['reschedule_reminder','complete_reminder','update_progress'].includes(intent.type)) {
        const label = node('label', 'Конкретная задача'), select = node('select', undefined, { 'data-draft-field':'reminder_id', 'aria-label':'Конкретная задача' });
        options(select, draft.reminder_id); select.required = true;
        select.addEventListener('change', () => {
          draft.reminder_id = select.value;
          draft.target_revision = (available.find(item => item.id === select.value) || (selected?.id === select.value ? selected : null))?.revision;
        });
        label.append(select); form.append(label);
      }
      if (['create_reminder','reschedule_reminder'].includes(intent.type)) { field('due_local', 'Дата и время', 'datetime-local'); field('timezone', 'Часовой пояс IANA'); }
      if (intent.type === 'update_progress') { field('progress_current', 'Выполнено', 'number'); field('progress_total', 'Всего', 'number'); }
      if (actionable) {
        const confirm = node('button', intent.type === 'dataset_candidate' ? 'Подтвердить смену режима' : 'Подтвердить и сохранить', { type:'submit' }); form.append(confirm);
        form.addEventListener('submit', event => {
          event.preventDefault();
          void operation(async () => { await api.voiceAssistantConfirm(row.id, { ...draft }); drafts.delete(row.id); });
        });
      } else button('Уточнить текстом', async () => { find('[data-command]').value = row.text; find('[data-command]').focus(); });
      button('Отклонить', async () => { await api.voiceAssistantReject(row.id, row.revision); drafts.delete(row.id); });
    }
    return li;
  }
  function reminder(item) {
    const li = node('li');
    li.append(node('strong', item.title), node('p', `${date(item.due_at, item.timezone)} · ${item.timezone} · ${item.status === 'done' ? 'Завершено' : 'Открыто'}`));
    if (item.progress_total != null) li.append(node('p', `Прогресс: ${item.progress_current} / ${item.progress_total}`));
    if (item.status === 'open') {
      const choose = node('button', 'Выбрать для команды', { type:'button', 'data-target-choice':'' }); choose.disabled = busy;
      choose.addEventListener('click', () => {
        if (busy) return;
        selected = item; options(find('[data-command-target]'), item.id); find('[data-command]').focus();
        void operation(async () => renderState(await api.voiceAssistantSelect(item.id)));
      }); li.append(choose);
    }
    const history = node('button', 'История', { type:'button' }), output = node('ul');
    history.addEventListener('click', () => void operation(async () => {
      const entries = await api.voiceReminderHistory(item.id);
      output.replaceChildren(...entries.map(entry => node('li', `${date(entry.at, item.timezone)} · ${labels[entry.kind] || entry.kind}${entry.details.progress_total == null ? '' : ` · ${entry.details.progress_current} / ${entry.details.progress_total}`}`)));
      if (!entries.length) output.append(node('li', 'История пуста.'));
    })); li.append(history, output); return li;
  }
  async function refresh() {
    const current = ++sequence;
    const [proposals, reminders, open] = await Promise.all([
      api.voiceAssistantList({ offset:proposalOffset, limit:10, filter:find('[data-proposal-filter]').value }),
      api.voiceReminders({ offset:reminderOffset, limit:10, status:find('[data-reminder-filter]').value }),
      api.voiceReminders({ limit:50, status:'open' })
    ]);
    if (disposed || current !== sequence) return;
    available = open.items;
    if (selected) selected = [...available, ...reminders.items].find(item => item.id === selected.id && item.status === 'open') || selected;
    options(find('[data-command-target]'), selectedId);
    const active = document.activeElement, activeId = active?.closest('[data-proposal-id]')?.dataset.proposalId;
    const activeField = active?.dataset.draftField, selection = [active?.selectionStart, active?.selectionEnd];
    proposalTotal = proposals.total; reminderTotal = reminders.total;
    find('[data-proposals]').replaceChildren(...proposals.items.map(card));
    if (!proposals.items.length) find('[data-proposals]').append(node('li', 'Пока нет команд.'));
    if (activeId && activeField) {
      const replacement = [...section.querySelectorAll('[data-proposal-id]')].find(item => item.dataset.proposalId === activeId)?.querySelector(`[data-draft-field="${activeField}"]`);
      replacement?.focus({ preventScroll:true });
      if (replacement?.type === 'text' && selection[0] != null) replacement.setSelectionRange(...selection);
    }
    // Keep an opened history intact during status-only updates.
    const list = find('[data-reminders]'), signature = JSON.stringify(reminders.items);
    if (list.dataset.signature !== signature) { list.replaceChildren(...reminders.items.map(reminder)); list.dataset.signature = signature; }
    if (!reminders.items.length) list.replaceChildren(node('li', 'Напоминаний нет.'));
    for (const [name, offset, total] of [['proposals',proposalOffset,proposalTotal],['reminders',reminderOffset,reminderTotal]]) {
      find(`[data-${name}-prev]`).disabled = offset === 0;
      find(`[data-${name}-next]`).disabled = offset + 10 >= total;
      find(`[data-${name}-page]`).textContent = total ? `${offset + 1}–${Math.min(offset + 10, total)} из ${total}` : '0';
    }
    for (const key of drafts.keys()) if (!proposals.items.some(item => item.id === key)) drafts.delete(key);
  }
  for (const key of fields) find(`[name="${key}"]`).addEventListener('input', () => { dirty = true; });
  find('[name="backend"]').addEventListener('change', () => {
    if (['http://127.0.0.1:11434','http://127.0.0.1:1234/v1'].includes(find('[name="endpoint"]').value)) find('[name="endpoint"]').value = find('[name="backend"]').value === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1';
  });
  async function save() {
    for (const key of fields) if (!find(`[name="${key}"]`).reportValidity()) return false;
    const next = await api.voiceAssistantSave(readSettings()); dirty = false; renderState(next); return true;
  }
  find('[data-save-qwen]').addEventListener('click', () => void operation(save));
  find('[data-models]').addEventListener('click', () => void operation(async () => {
    if (!await save()) return;
    const models = await api.voiceAssistantModels();
    find('datalist').replaceChildren(...models.map(value => new Option(value, value)));
    find('[data-models-status]').textContent = models.length ? `Найдено моделей: ${models.length}. Выберите имя в поле модели и сохраните.` : 'Сервер доступен, но локальных моделей нет.';
  }));
  find('[data-cancel-qwen]').addEventListener('click', () => {
    void api.voiceAssistantCancel().then(next => { renderState(next); return refresh(); }).catch(error => { find('[data-assistant-error]').textContent = error.message; });
  });
  find('[data-refresh-qwen]').addEventListener('click', () => void operation(async () => renderState(await api.voiceAssistantStatus())));
  find('[data-send-command]').addEventListener('click', () => void operation(async () => {
    const text = find('[data-command]').value;
    if (!text.trim()) throw new Error('Введите команду.');
    await api.voiceAssistantText({ text, selected_id:find('[data-command-target]').value || null });
    find('[data-command]').value = ''; proposalOffset = 0;
  }));
  find('[data-command-target]').addEventListener('change', () => {
    const id = find('[data-command-target]').value || null;
    selected = available.find(item => item.id === id) || selected;
    void operation(async () => renderState(await api.voiceAssistantSelect(id)));
  });
  for (const name of ['proposals','reminders']) for (const [direction, delta] of [['prev',-10],['next',10]]) find(`[data-${name}-${direction}]`).addEventListener('click', () => void operation(async () => {
    if (name === 'proposals') proposalOffset = Math.max(0, proposalOffset + delta); else reminderOffset = Math.max(0, reminderOffset + delta);
  }));
  find('[data-proposal-filter]').addEventListener('change', () => void operation(async () => { proposalOffset = 0; }));
  find('[data-reminder-filter]').addEventListener('change', () => void operation(async () => { reminderOffset = 0; }));
  const unsubscribe = api.onVoiceAssistant(next => {
    renderState(next);
    clearTimeout(timer);
    if (panel.open) timer = setTimeout(() => { void refresh().catch(error => { find('[data-assistant-error]').textContent = error.message; }); }, 120);
  });
  window.addEventListener('pagehide', () => { disposed = true; sequence++; clearTimeout(timer); unsubscribe(); }, { once:true });
  void api.voiceAssistantStatus().then(next => { renderState(next); return refresh(); }).catch(error => { find('[data-assistant-error]').textContent = error.message; });
  return { section, refresh:() => operation(async () => {}) };
}
