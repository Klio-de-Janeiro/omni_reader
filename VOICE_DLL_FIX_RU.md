# Ошибка DLL в прежнем окружении Torch

Актуальное исправление запуска диктофона описано в `VOICE_STARTUP_FIX_RU.md`.
Для сбоя `onnxruntime_pybind11_state` смотрите `VOICE_ONNX_DLL_FIX_RU.md`.
Диктофон теперь использует локальную ONNX-модель Silero без импорта Torch.
Установочный скрипт больше не требует работающего Torch или его переустановки.

Прежняя диагностика на ноутбуке показала Python 3.11.9 x64 и Torch 2.14.1+cpu:
отдельный `import torch` завершался `WinError 1114` при загрузке `c10.dll`.
Конкретная неисправная DLL-зависимость не была установлена. Переход диктофона
на ONNX обходит именно эту зависимость; новое сообщение о таймауте само по
себе не доказывает, что было вызвано тем же сбоем.

В PowerShell из папки проекта обновите отдельное голосовое окружение:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\SETUP_VOICE_WINDOWS.ps1
```

Python диктофона: `C:\Users\User\Desktop\omni_voice_env\Scripts\python.exe`.
Установка Whisper и его модель остаются в прежнем окружении. Torch, если он
уже установлен в `omni_voice_env`, может остаться: диктофон его не загружает.

Для анализа старой установки Torch сохранён необязательный режим диагностики:

```powershell
& "$env:USERPROFILE\Desktop\omni_voice_env\Scripts\python.exe" -u .\scripts\check-voice-runtime.py --torch
```

Для актуального диктофона используйте ту же команду с `--audio` вместо `--torch`.
Обе самопроверки имеют ограниченное время ожидания и завершают зависший процесс.
