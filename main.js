const { app, Tray, Menu, BrowserWindow, dialog, nativeImage, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const chokidar = require('chokidar');
let store = null;

async function initializeStore() {
  const { default: Store } = await import('electron-store');
  store = new Store({
    name: 'settings',
    defaults: {
      watchedFolders: [],
      tinifyApiKey: '',
      tinifyEnabled: true,
      tinifyCount: 0,
    },
  });
}

function setTinifyApiKey() {
  const currentApiKey = store.get('tinifyApiKey', '');
  const currentApiKeyPreview = currentApiKey ? currentApiKey.slice(0, 8) : '未設定';
  const saveChannel = `tinify-api-key:save:${Date.now()}`;
  const cancelChannel = `tinify-api-key:cancel:${Date.now()}`;
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));

  const apiKeyWindow = new BrowserWindow({
    width: 420,
    height: 240,
    title: 'TinyPNG APIキーを設定',
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    ipcMain.removeAllListeners(saveChannel);
    ipcMain.removeAllListeners(cancelChannel);
    if (!apiKeyWindow.isDestroyed()) {
      apiKeyWindow.close();
    }
  };

  ipcMain.once(saveChannel, (_event, apiKey) => {
    const result = apiKey.trim();
    store.set('tinifyApiKey', result);
    pushLog('TinyPNG APIキーを更新しました');
    dialog.showMessageBox({
      type: 'info',
      title: '保存しました',
      message: 'TinyPNG APIキーを保存しました',
      buttons: ['OK'],
    });

    if (serverRunning) {
      stopServer();
      setTimeout(startServer, 1000);
    }

    cleanup();
  });

  ipcMain.once(cancelChannel, cleanup);
  apiKeyWindow.on('closed', cleanup);

  apiKeyWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            margin: 24px;
            color: #222;
          }
          label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
          }
          input {
            box-sizing: border-box;
            width: 100%;
            padding: 8px;
            font-size: 14px;
          }
          .current {
            margin-bottom: 16px;
            color: #555;
          }
          .actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 20px;
          }
          button {
            padding: 6px 14px;
          }
        </style>
      </head>
      <body>
        <div class="current">現在のキー: ${escapeHtml(currentApiKeyPreview)}</div>
        <form id="api-key-form">
          <label for="api-key">TinyPNG APIキー</label>
          <input id="api-key" type="password" autocomplete="off" autofocus />
          <div class="actions">
            <button type="button" id="cancel">キャンセル</button>
            <button type="submit">保存</button>
          </div>
        </form>
        <script>
          const { ipcRenderer } = require('electron');
          const form = document.getElementById('api-key-form');
          const input = document.getElementById('api-key');
          const cancel = document.getElementById('cancel');

          form.addEventListener('submit', (event) => {
            event.preventDefault();
            ipcRenderer.send('${saveChannel}', input.value);
          });

          cancel.addEventListener('click', () => {
            ipcRenderer.send('${cancelChannel}');
          });
        </script>
      </body>
    </html>
  `)}`);
}

function toggleTinify() {
  const current = store.get('tinifyEnabled', false);
  store.set('tinifyEnabled', !current);
  pushLog(`TinyPNG ${!current ? '有効' : '無効'} に変更しました`);
  if (serverRunning) {
    stopServer();
    setTimeout(() => startServer(), 1000);
  }
  updateTrayMenu();
}

function buildTinifyGauge() {
  const count = store.get('tinifyCount', 0);
  const enabled = store.get('tinifyEnabled', false);
  const remaining = 500 - count;
  const filled = Math.round((remaining / 500) * 10);
  const empty = 10 - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const status = enabled ? 'ON' : 'OFF';
  return `TinyPNG [${status}]  ${bar}  ${remaining}/500`;
}

let tray = null;
let logWindow = null;
let serverProcess = null;
let serverRunning = false;
const logs = [];
const folderWatchers = new Map();
const processingFiles = new Set();
const WATCHED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const WATCHED_FILE_EXTENSIONS = new Set([...WATCHED_IMAGE_EXTENSIONS, '.zip']);

function pushLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  logs.push(line);
  if (logs.length > 500) logs.shift();
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.webContents.send('logs:update', logs.join('\n'));
  }
}

function getWatchedFolders() {
  return store.get('watchedFolders', []);
}

function setWatchedFolders(folders) {
  store.set('watchedFolders', folders);
}

async function postToServer(endpoint, filePath) {
  try {
    const response = await fetch(`http://localhost:3000${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filePath }),
    });

    const json = await response.json();
    if (!response.ok) {
      throw new Error(json.error || `HTTP ${response.status}`);
    }

    pushLog(`${endpoint} succeeded: ${filePath}`);
  } catch (error) {
    pushLog(`[ERROR] ${endpoint} failed: ${filePath} (${error.message})`);
  }
}

function isWatchedFile(filePath) {
  return WATCHED_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function handleDetectedFile(filePath) {
  if (!isWatchedFile(filePath)) return;
  if (processingFiles.has(filePath)) {
    pushLog(`[watch] skipped reason=inProgress path=${filePath}`);
    return;
  }
  processingFiles.add(filePath);

  try {
    const ext = path.extname(filePath).toLowerCase();
    if (WATCHED_IMAGE_EXTENSIONS.has(ext)) {
      pushLog(`[watch] posting endpoint=/compress path=${filePath}`);
      await postToServer('/compress', filePath);
    } else if (ext === '.zip') {
      pushLog(`[watch] posting endpoint=/extract path=${filePath}`);
      await postToServer('/extract', filePath);
    }
  } finally {
    processingFiles.delete(filePath);
  }
}

function startWatchingFolder(folderPath) {
  if (folderWatchers.has(folderPath)) return;

  // Chokidar v4 does not expand glob patterns, so watch the directory
  // itself and filter the top-level add events by extension below.
  const watcher = chokidar.watch(folderPath, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100,
    },
  });

  watcher.on('add', (filePath) => {
    if (!isWatchedFile(filePath)) return;

    pushLog(`[watch] event=add path=${filePath}`);
    handleDetectedFile(filePath);
  });

  watcher.on('error', (error) => {
    pushLog(`[ERROR] Watcher error (${folderPath}): ${error.message}`);
  });

  folderWatchers.set(folderPath, watcher);
  pushLog(`Started watching folder: ${folderPath}`);
}

function stopWatchingFolder(folderPath) {
  const watcher = folderWatchers.get(folderPath);
  if (!watcher) return;

  watcher.close();
  folderWatchers.delete(folderPath);
  pushLog(`Stopped watching folder: ${folderPath}`);
}

function syncFolderWatchers() {
  const savedFolders = new Set(getWatchedFolders());

  for (const existingFolder of folderWatchers.keys()) {
    if (!savedFolders.has(existingFolder)) {
      stopWatchingFolder(existingFolder);
    }
  }

  for (const folderPath of savedFolders) {
    startWatchingFolder(folderPath);
  }
}

async function addWatchedFolder() {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: '監視するフォルダを選択',
  });

  if (result.canceled || result.filePaths.length === 0) return;

  const [selectedFolder] = result.filePaths;
  const folders = getWatchedFolders();

  if (folders.includes(selectedFolder)) {
    pushLog(`Folder is already watched: ${selectedFolder}`);
    return;
  }

  const updated = [...folders, selectedFolder];
  setWatchedFolders(updated);
  startWatchingFolder(selectedFolder);
  updateTrayMenu();
}

function removeWatchedFolder(folderPath) {
  const updatedFolders = getWatchedFolders().filter((folder) => folder !== folderPath);
  setWatchedFolders(updatedFolders);
  stopWatchingFolder(folderPath);
  updateTrayMenu();
}

function clearWatchedFolders() {
  for (const folder of getWatchedFolders()) {
    stopWatchingFolder(folder);
  }
  setWatchedFolders([]);
  updateTrayMenu();
}

function createWatchedFolderManagementSubmenu() {
  const folders = getWatchedFolders();

  if (folders.length === 0) {
    return [{ label: '監視フォルダはありません', enabled: false }];
  }

  return [
    ...folders.map((folderPath) => ({
      label: `削除: ${folderPath}`,
      click: () => removeWatchedFolder(folderPath),
    })),
    { type: 'separator' },
    { label: 'すべての監視を解除', click: clearWatchedFolders },
  ];
}

function updateTrayMenu() {
  const statusLabel = serverRunning ? '● 稼働中' : '● 停止中';
  const template = [
    { label: statusLabel, enabled: false },
    { label: buildTinifyGauge(), enabled: false },
    {
      label: store.get('tinifyEnabled', false) ? 'TinyPNG を無効にする' : 'TinyPNG を有効にする',
      click: toggleTinify,
    },
    { type: 'separator' },
    { label: '圧縮を開始', click: startServer, enabled: !serverRunning },
    { label: '圧縮を停止', click: stopServer, enabled: serverRunning },
    { type: 'separator' },
    { label: '監視フォルダを追加', click: addWatchedFolder },
    { label: '監視フォルダを管理', submenu: createWatchedFolderManagementSubmenu() },
    { type: 'separator' },
    { label: 'TinyPNG APIキーを設定', click: setTinifyApiKey },
    { label: 'ログを見る', click: openLogWindow },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function startServer() {
  if (serverProcess) return;

  const serverPath = path.join(__dirname, 'app', 'index.js');
  const tinifyApiKey = store.get('tinifyApiKey', '');
  const tinifyEnabled = store.get('tinifyEnabled', false);
  serverProcess = spawn(process.execPath, [serverPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TINIFY_ENABLED: tinifyEnabled ? '1' : '0',
      ...(tinifyApiKey && tinifyEnabled ? { TINIFY_API_KEY: tinifyApiKey } : {}),
    },
  });

  serverRunning = true;
  pushLog('Compression server started on port 3000.');
  updateTrayMenu();

  serverProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    pushLog(text);

    const match = text.match(/compressionCount=(\d+)\/500/);
    if (match) {
      store.set('tinifyCount', parseInt(match[1], 10));
      updateTrayMenu();
    }
  });
  serverProcess.stderr.on('data', (data) => pushLog(`[ERROR] ${data.toString().trim()}`));

  serverProcess.on('exit', (code, signal) => {
    pushLog(`Compression server stopped (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`);
    serverProcess = null;
    serverRunning = false;
    updateTrayMenu();
  });
}

function stopServer() {
  if (!serverProcess) return;
  pushLog('Stopping compression server...');
  serverProcess.kill('SIGTERM');
}

function openLogWindow() {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.focus();
    return;
  }

  logWindow = new BrowserWindow({
    width: 640,
    height: 480,
    title: 'ImageCompressor Logs',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  logWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  logWindow.webContents.on('did-finish-load', () => {
    logWindow.webContents.send('logs:update', logs.join('\n'));
  });
}

function initializeTray() {
  const trayIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const trayIcon = nativeImage.createFromPath(trayIconPath).resize({ width: 18, height: 18 });
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip('ImageCompressor');
  tray.on('click', () => tray.popUpContextMenu());
  updateTrayMenu();
}

app.whenReady().then(async () => {
  if (app.dock && typeof app.dock.hide === 'function') {
    app.dock.hide();
  }

  app.setLoginItemSettings({ openAtLogin: true });

  await initializeStore();
  initializeTray();
  syncFolderWatchers();
  startServer();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }

  for (const watcher of folderWatchers.values()) {
    watcher.close();
  }
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

process.on('uncaughtException', (error) => {
  pushLog(`[FATAL] ${error.stack || error.message}`);
  dialog.showErrorBox('Fatal Error', error.message);
});
