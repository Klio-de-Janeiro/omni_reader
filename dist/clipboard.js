/** Copy only in response to a visible user action, with a WebView fallback. */
export async function copyText(text) {
  if (!text) throw new Error('Сначала выделите текст или ячейки.');
  if (text.length > 2_000_000) throw new Error('Выделение слишком большое для буфера обмена.');
  if (navigator.userAgent.includes('OmniAndroid')) {
    const result = prompt('OMNI_NATIVE', JSON.stringify({ action: 'copy', text }));
    if (result !== 'ok') throw new Error('Не удалось скопировать текст.');
    return;
  }
  try { await navigator.clipboard.writeText(text); }
  catch {
    const textarea = document.createElement('textarea'); textarea.value = text;
    textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.append(textarea);
    textarea.select(); const success = document.execCommand('copy'); textarea.remove();
    if (!success) throw new Error('Копирование недоступно. Используйте системное меню выделения.');
  }
}
