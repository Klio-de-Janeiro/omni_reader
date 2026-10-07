/** Keep reversible edits without copying whole documents into every history step. */
export class History {
  constructor(onChange = () => {}) { this.done = []; this.future = []; this.baselineLost = false; this.onChange = onChange; }
  execute(redo, undo, mergeKey = null) {
    const now = Date.now(), previous = this.done.at(-1);
    redo();
    if (mergeKey && !this.future.length && previous?.mergeKey === mergeKey && now - previous.time < 800) { previous.redo = redo; previous.time = now; }
    else this.done.push({ redo, undo, mergeKey, time: now });
    this.future = [];
    if (this.done.length > 100) { this.done.shift(); this.baselineLost = true; }
    this.onChange();
  }
  undo() { const step = this.done.pop(); if (step) { step.undo(); this.future.push(step); this.onChange(); } }
  redo() { const step = this.future.pop(); if (step) { step.redo(); this.done.push(step); this.onChange(); } }
  get dirty() { return this.baselineLost || this.done.length > 0; }
}

/** Reject XML control characters before a user edit can corrupt an Office file. */
export function checkedText(value, maxLength = 32767) {
  const text = String(value);
  if (text.length > maxLength) throw new Error(`Лимит текста: ${maxLength} символов.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text)) throw new Error('Текст содержит недопустимые управляющие символы.');
  for (const ch of text) { const code = ch.codePointAt(0); if (code >= 0xd800 && code <= 0xdfff) throw new Error('Неполный символ Unicode.'); }
  return text;
}
