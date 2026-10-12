const { app, Tray, Menu, shell, dialog, ipcMain, powerMonitor } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RecorderService } = require('./recorder.cjs');
const { VoiceTranscripts } = require('./voice-transcripts.cjs');
const { VoiceDataset, DEFAULT_MODEL } = require('./voice-dataset.cjs');
const { VoiceCommands } = require('./voice-commands.cjs');

/** Attach a single recorder, trusted IPC and an explicit background lifecycle. */
function installRecorder({ windows, createWindow, senderState, speech }) {
  let tray, closing = false, shutdownFinished = false, recorder, transcripts, dataset, commands;
  const intake = new Set();
  const root = path.join(__dirname, 'www');
  const show = () => {
    const window = [...windows.values()].find(state => !state.window.isDestroyed())?.window || createWindow().window;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  };
  const send = (channel, value) => {
    for (const { window } of windows.values()) if (!window.isDestroyed()) {
      try { window.webContents.send(channel, value); } catch {}
    }
  };
  const updateTray = () => {
    if (closing) return;
    if (recorder?.active || transcripts?.busy || dataset?.busy || commands?.busy || intake.size) ensureTray();
    else if (tray) {
      if (![...windows.values()].some(item => item.window.isVisible())) show();
      tray.destroy(); tray = null;
    }
    if (tray) tray.setToolTip('Omni · ' + (recorder?.active ? (recorder.snapshot().message || 'Микрофон включён').slice(0, 90) : dataset?.busy ? 'Проверка голоса / датасет' : commands?.busy ? 'Qwen: обработка команды' : 'Whisper: очередь распознавания'));
  };
  dataset = new VoiceDataset(app.getPath('userData'), path.join(app.isPackaged ? process.resourcesPath : __dirname, 'voice', 'speaker.py'), {
    defaults: async () => {
      const environment = path.join(app.getPath('home'), 'Desktop', 'omni_voice_env');
      return { python: path.join(environment, 'Scripts', 'python.exe'), model: path.join(environment, 'models', DEFAULT_MODEL) };
    }, report: state => { send('omni-voice-dataset-state', state); updateTray(); }
  });
  transcripts = new VoiceTranscripts(app.getPath('userData'), speech, state => {
    send('omni-recorder-transcripts-state', state); updateTray();
  }, { onCompleted: async item => {
    await dataset.noteTranscript(item);
    if (item.status !== 'done' || !commands || commands.closed || closing) return;
    const entry = dataset.items.find(clip => clip.id === item.id);
    const full = await transcripts.text(item.id);
    await commands.input({ ...item, text: full.text, role: entry?.role || item.capture_role || 'candidate' });
  } });
  commands = new VoiceCommands(app.getPath('userData'), speech, state => {
    send('omni-voice-assistant-state', state); updateTray();
  }, { checkOwner: async (id, signal) => {
    await dataset.ready;
    if (signal.aborted) throw new Error('Обработка Qwen отменена.');
    dataset.assertIdle();
    const result = dataset.run('verify', [dataset.find(id).id]);
    const cancel = () => dataset.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try { await result; return dataset.summary(dataset.find(id)).decision === 'owner'; }
    finally { signal.removeEventListener('abort', cancel); }
  } });
  recorder = new RecorderService(app.getPath('userData'), path.join(app.isPackaged ? process.resourcesPath : __dirname, 'voice', 'record.py'), async () => {
    return path.join(app.getPath('home'), 'Desktop', 'omni_voice_env', 'Scripts', 'python.exe');
  }, state => {
    if (!state.active && dataset.captureRole === 'reference') dataset.enrollment(false);
    send('omni-recorder-state', state); updateTray();
  }, { onClip: (clip, enabled) => {
    const role = dataset.captureRole;
    // Register before Whisper starts; neither operation modifies raw metadata.
    const operation = dataset.register(clip, { role }).catch(error => {
      dataset.problem = 'WAV сохранён; каталог датасета: ' + error.message; dataset.publish();
    }).then(() => transcripts.submit({ ...clip, capture_role: role }, enabled)).catch(error => {
      transcripts.paused = true; transcripts.problem = 'Ошибка очереди: ' + error.message; transcripts.publish();
    }).finally(() => { intake.delete(operation); updateTray(); });
    intake.add(operation);
  } });
  const bootstrap = Promise.all([dataset.ready, transcripts.ready]).then(async () => {
    await dataset.seed(transcripts.items || []);
    for (const item of transcripts.items || []) await dataset.noteTranscript(item);
  }).catch(error => { dataset.problem = 'Импорт истории: ' + error.message; dataset.publish(); }).finally(() => { intake.delete(bootstrap); updateTray(); });
  intake.add(bootstrap);
  function ensureTray() {
    if (tray) return;
    tray = new Tray(path.join(root, 'icon-192.png'));
    tray.setToolTip('Omni · запуск диктофона');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть Omni', click: show },
      { label: 'Остановить микрофон', click: () => { void recorder.stop(); } },
      { type: 'separator' },
      { label: 'Выйти из Omni', click: () => app.quit() }
    ]));
    tray.on('double-click', show);
  }
  const handle = (name, action) => ipcMain.handle('omni-recorder-' + name, (event, ...args) => action(senderState(event), ...args));
  handle('status', () => recorder.snapshot());
  handle('settings', () => recorder.settings());
  handle('devices', () => recorder.devices());
  handle('save', (_state, params) => recorder.save(params));
  handle('silence', (_state, milliseconds) => recorder.setSilence(milliseconds));
  handle('auto', (_state, enabled) => recorder.setAuto(enabled));
  handle('transcripts', async () => { await transcripts.ready; return transcripts.snapshot(); });
  handle('retry', (_state, id) => transcripts.retry(id));
  handle('text', (_state, id) => transcripts.text(id));
  handle('cancel-transcript', (_state, id) => transcripts.cancel(id));
  handle('resume-transcripts', () => transcripts.resume());
  handle('pause-transcripts', () => transcripts.pause());
  const commandHandle = (name, action) => ipcMain.handle('omni-voice-assistant-' + name, (event, ...args) => action(senderState(event), ...args));
  commandHandle('status', async () => { await commands.ready; return commands.snapshot(); });
  commandHandle('save', (_state, value) => commands.configure(value));
  commandHandle('models', () => commands.models());
  commandHandle('text', (_state, value) => commands.text(value));
  commandHandle('select', (_state, id) => commands.select(id));
  commandHandle('list', (_state, query) => commands.list(query));
  commandHandle('reminders', (_state, query) => commands.reminders(query));
  commandHandle('history', (_state, id) => commands.history(id));
  commandHandle('retry', (_state, id) => commands.retry(id));
  commandHandle('reject', (_state, id, revision) => commands.reject(id, revision));
  commandHandle('confirm', (_state, id, value) => commands.confirm(id, value));
  commandHandle('cancel', () => commands.cancel());
  const dataHandle = (name, action) => ipcMain.handle('omni-voice-dataset-' + name, (event, ...args) => action(senderState(event), ...args));
  dataHandle('status', async () => { await dataset.ready; return dataset.snapshot(); });
  dataHandle('list', (_state, query) => dataset.list(query));
  dataHandle('detail', (_state, id) => dataset.detail(id));
  dataHandle('audio', (_state, id) => dataset.audio(id));
  dataHandle('review', (_state, id, value) => dataset.review(id, value));
  dataHandle('recognize', async (_state, id) => {
    await dataset.ready; await transcripts.ready;
    const item = dataset.find(id);
    if (!transcripts.items.some(entry => entry.id === id)) await transcripts.submit(item, false);
    return transcripts.retry(id);
  });
  dataHandle('analyze', async (_state, mode, id) => { await Promise.all([...intake]); return dataset.analyze(mode, id); });
  dataHandle('cancel', () => dataset.cancel());
  dataHandle('auto', (_state, enabled) => dataset.setAuto(enabled));
  dataHandle('record-reference', async () => {
    await dataset.ready; dataset.assertIdle(); recorder.assertIdle(); dataset.enrollment(true); ensureTray();
    try { return recorder.start(); }
    catch (error) { dataset.enrollment(false); updateTray(); throw error; }
  });
  dataHandle('choose', async (state, kind) => {
    await dataset.ready; dataset.assertIdle();
    if (!['python', 'model'].includes(kind)) throw new Error('Неверная настройка speaker-модели.');
    const selected = await dialog.showOpenDialog(state.window, { title: kind === 'python' ? 'Python omni_voice_env' : 'Локальная speaker-модель ONNX', properties: ['openFile'], filters: [{ name: kind === 'python' ? 'Python' : 'ONNX', extensions: kind === 'python' ? ['exe', '*'] : ['onnx'] }] });
    if (state.window.isDestroyed() || selected.canceled || !selected.filePaths?.length) return null;
    return dataset.configure(kind, selected.filePaths[0]);
  });
  dataHandle('import', async state => {
    await dataset.ready; dataset.assertIdle();
    const selected = await dialog.showOpenDialog(state.window, { title: 'WAV mono PCM16, 16 кГц', properties: ['openFile', 'multiSelections'], filters: [{ name: 'WAV', extensions: ['wav'] }] });
    if (state.window.isDestroyed() || selected.canceled) return null;
    if (!selected.filePaths || selected.filePaths.length > 50) throw new Error('Импортируйте не более 50 WAV за раз.');
    for (const source of selected.filePaths) {
      const resolved = await fs.realpath(source);
      if (!dataset.items.some(item => item.path === resolved)) await dataset.register({ id: randomUUID(), path: resolved }, { auto: false, role: 'candidate' });
    }
    return dataset.snapshot();
  });
  dataHandle('export', async state => {
    await dataset.ready; dataset.assertIdle();
    const selected = await dialog.showOpenDialog(state.window, { title: 'Папка для экспорта WAV + JSONL + TXT', properties: ['openDirectory', 'createDirectory'] });
    if (state.window.isDestroyed() || selected.canceled || !selected.filePaths?.length) return null;
    return dataset.export(selected.filePaths[0]);
  });
  handle('start', () => {
    recorder.assertIdle(); ensureTray();
    try { return recorder.start(); }
    catch (error) { tray?.destroy(); tray = null; throw error; }
  });
  handle('stop', () => recorder.stop());
  handle('hide', state => {
    if ((!recorder.active && !transcripts.busy && !dataset.busy && !commands.busy && !intake.size) || !tray) throw new Error('Сначала включите диктофон или обработку записей.');
    state.window.hide();
  });
  handle('choose', async (state, kind) => {
    recorder.assertIdle();
    if (!['python', 'folder'].includes(kind)) throw new Error('Неверная настройка.');
    const selected = await dialog.showOpenDialog(state.window, {
      title: kind === 'python' ? 'Python для диктофона (omni_voice_env)' : 'Папка речевых фрагментов',
      properties: [kind === 'python' ? 'openFile' : 'openDirectory'],
      ...(kind === 'python' ? { filters: [{ name: 'Python', extensions: ['exe', '*'] }] } : {})
    });
    if (state.window.isDestroyed() || selected.canceled || !selected.filePaths?.length) return null;
    return recorder.configure(kind, selected.filePaths[0]);
  });
  handle('folder', async () => {
    const config = await recorder.settings();
    await fs.mkdir(config.folder, { recursive: true });
    const error = await shell.openPath(config.folder);
    if (error) throw new Error(error);
  });
  powerMonitor.on('suspend', () => { commands.cancel(); dataset.cancel(); void recorder.stop(); });
  app.on('before-quit', event => {
    if (shutdownFinished) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    transcripts.suspend();
    commands.cancel();
    dataset.cancel();
    void recorder.shutdown().then(() => Promise.all([...intake])).then(() => commands.shutdown()).then(() => transcripts.shutdown()).then(() => dataset.shutdown()).catch(error => {
      dialog.showErrorBox('Omni · завершение записи', error.message);
    }).finally(() => { shutdownFinished = true; closing = false; app.quit(); });
  });
  return {
    get keepAlive() { return recorder.active || transcripts.busy || dataset.busy || commands.busy || intake.size > 0; },
    attachWindow(window) {
      window.on('close', event => {
        if (!closing && (recorder.active || transcripts.busy || dataset.busy || commands.busy || intake.size) && tray) { event.preventDefault(); window.hide(); }
      });
    }
  };
}
module.exports = { installRecorder };
