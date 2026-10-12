/** Build controls from the schema supplied by the desktop settings service. */
export function createSpeechOptions(container, fields, onEdit) {
  const document = container.ownerDocument, controls = new Map();
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
  const basic = node('div', '', 'speech-options-grid'), advanced = node('details', '', 'speech-advanced');
  const extra = node('div', '', 'speech-options-grid'); advanced.append(node('summary', 'Дополнительные параметры'), extra);
  const mode = node('p', '', 'speech-note'); container.append(basic, mode, advanced);
  const names = new Intl.DisplayNames(['ru'], { type: 'language' });
  let locked = false, modelPath = '';
  for (const field of fields) {
    const row = node('label', '', 'speech-option'), control = node(field.type === 'select' ? 'select' : field.type === 'textarea' ? 'textarea' : 'input');
    control.name = field.key; control.setAttribute('aria-label', field.label);
    if (field.type === 'select') {
      for (const choice of field.choices) {
        const [value, title] = Array.isArray(choice) ? choice : [choice, choice === 'auto' ? 'Автоопределение' : names.of(choice) || choice];
        const option = node('option', title); option.value = value; control.append(option);
      }
    } else if (field.type === 'number') {
      control.type = 'number'; control.required = true;
      for (const key of ['min', 'max', 'step']) control[key] = field[key];
    } else if (field.type === 'checkbox') { control.type = 'checkbox'; row.classList.add('speech-checkbox'); }
    else { control.rows = 3; control.maxLength = field.maxLength; row.classList.add('speech-prompt'); }
    control.addEventListener('input', () => { refreshMode(); onEdit(); });
    row.append(node('span', field.label), control, node('small', field.help));
    (field.advanced ? extra : basic).append(row); controls.set(field.key, control);
  }
  function refreshMode() {
    const sampling = Number(controls.get('temperature').value) > 0, fallback = controls.get('temperature_fallback').checked;
    for (const [key, control] of controls) {
      control.disabled = locked || (['beam_size', 'patience'].includes(key) && sampling) || (key === 'best_of' && !sampling && !fallback) || (key === 'compute_type' && /\.pt$/i.test(modelPath));
    }
    mode.textContent = sampling ? 'Температура больше 0: используется Best of; Beam size и Patience не участвуют.'
      : 'Температура 0: используется Beam size.' + (fallback ? ' Best of применяется при повторной попытке с повышенной температурой.' : ' Best of не участвует.');
  }
  return {
    set(values, model) {
      modelPath = model || '';
      for (const field of fields) {
        const value = values?.[field.key] ?? field.default, control = controls.get(field.key);
        if (field.type === 'checkbox') control.checked = value; else control.value = value;
      }
      refreshMode();
    },
    read() {
      return Object.fromEntries(fields.map(field => {
        const control = controls.get(field.key);
        if (!control.disabled && !control.reportValidity()) throw new Error('Проверьте параметр: ' + field.label + '.');
        if (field.type === 'number' && control.value.trim() === '') throw new Error('Укажите значение: ' + field.label + '.');
        return [field.key, field.type === 'checkbox' ? control.checked : field.type === 'number' ? Number(control.value) : control.value];
      }));
    },
    setModel(value) { modelPath = value || ''; refreshMode(); },
    lock(value) { locked = value; refreshMode(); }
  };
}
