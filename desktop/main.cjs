'use strict';
// Mermaid View Edit - Electron shell around the Mermaid Live Editor web app.
// Owns windows, file open/save, drag-onto-shortcut arguments, and updates.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require('electron');
const documents = require('./lib/documents.cjs');
const { createLogger, createSettings } = require('./lib/store.cjs');
const updater = require('./lib/updater.cjs');

const APP_NAME = updater.APP_NAME;
const APP_VERSION = app.getVersion();
const DATA_DIR = path.join(
  process.env.LOCALAPPDATA || app.getPath('appData'),
  'MermaidViewEdit'
);
const WEB_DIR = path.join(__dirname, 'web');
const APP_URL = 'mve://app/edit';
const ICON = path.join(__dirname, 'app.ico');
const UPDATE_INTERVAL_MS = 30 * 60 * 1000;
const FIRST_UPDATE_CHECK_MS = 15 * 1000;
// Test hook: when set, dialogs are suppressed and window/error state is written here.
const SMOKE_REPORT = process.env.MVE_SMOKE_REPORT;
const interactive = !SMOKE_REPORT;

// A portable build runs from a temp extraction; these point at the real exe.
const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const appDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(exePath);
const argvSkip = app.isPackaged ? 1 : 2;

app.setName(APP_NAME);
app.setPath('userData', path.join(DATA_DIR, 'browser'));
app.setAppUserModelId('com.curtislawfirm.mermaidviewedit');
const log = createLogger(path.join(DATA_DIR, 'logs'));
const settings = createSettings(DATA_DIR);

// ---------------------------------------------------------------------------
// Startup: update hand-off and single instance

// After an update the new version waits for the old process to exit so the
// two never share the browser profile at the same time.
const waitPid = Number(
  process.argv.find((arg) => arg.startsWith('--mve-wait-pid='))?.split('=')[1]
);
if (Number.isInteger(waitPid) && waitPid > 0) {
  const deadline = Date.now() + 20_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      process.kill(waitPid, 0);
    } catch {
      break;
    }
    Atomics.wait(pause, 0, 0, 250);
  }
}

const initialFiles = documents.filesFromArgv(process.argv, { skip: argvSkip });
if (!app.requestSingleInstanceLock({ files: initialFiles })) {
  // Another instance is running; it receives our files via 'second-instance'.
  app.quit();
  return;
}

protocol.registerSchemesAsPrivileged([
  {
    privileges: {
      codeCache: true,
      corsEnabled: true,
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true
    },
    scheme: 'mve'
  }
]);

// ---------------------------------------------------------------------------
// Window state

/** @type {Map<number, {win: BrowserWindow, doc?: object, savedCode?: string, currentCode?: string, mtimeMs?: number, ready: boolean, forceClose: boolean, reloadPrompt: boolean}>} */
const windows = new Map();
const smoke = { errors: [], version: APP_VERSION, windows: [] };

const writeSmokeReport = () => {
  if (!SMOKE_REPORT) return;
  smoke.windows = [...windows.values()].map((state) => ({
    file: state.doc?.path ?? null,
    ready: state.ready,
    title: state.win.isDestroyed() ? '' : state.win.getTitle()
  }));
  try {
    fs.writeFileSync(SMOKE_REPORT, JSON.stringify(smoke, undefined, 2));
  } catch (error) {
    log.error(`smoke report: ${error.message}`);
  }
};

const isDirty = (state) =>
  state.ready && state.savedCode !== undefined && state.currentCode !== state.savedCode;

const docName = (state) => {
  if (!state.doc) return 'Untitled';
  const base = path.basename(state.doc.path);
  return state.doc.blockCount > 1 ? `${base} [block ${state.doc.blockIndex + 1}]` : base;
};

const updateTitle = (state) => {
  if (state.win.isDestroyed()) return;
  state.win.setTitle(
    `${docName(state)}${isDirty(state) ? ' *' : ''} - ${APP_NAME} v${APP_VERSION}`
  );
  state.win.setDocumentEdited(isDirty(state));
  writeSmokeReport();
};

const stateFor = (webContents) => windows.get(webContents.id);
const focusedState = () => {
  const win = BrowserWindow.getFocusedWindow();
  return win ? stateFor(win.webContents) : undefined;
};

const showError = async (message, detail, win) => {
  log.error(`${message} ${detail ?? ''}`);
  if (!interactive) {
    smoke.errors.push({ detail, message });
    writeSmokeReport();
    return;
  }
  const options = { detail, message, title: APP_NAME, type: 'error' };
  await (win && !win.isDestroyed()
    ? dialog.showMessageBox(win, options)
    : dialog.showMessageBox(options));
};

// ---------------------------------------------------------------------------
// Watching files for outside changes (e.g. Claude or Dropbox updating a .mermaid)

const unwatch = (state) => {
  if (state.watching) fs.unwatchFile(state.watching);
  state.watching = undefined;
};

const watch = (state) => {
  unwatch(state);
  if (!state.doc) return;
  const filePath = state.doc.path;
  state.watching = filePath;
  fs.watchFile(filePath, { interval: 1500 }, (current) => {
    if (current.mtimeMs === 0 || current.mtimeMs === state.mtimeMs || state.reloadPrompt) return;
    void reloadFromDisk(state, current.mtimeMs);
  });
};

const reloadFromDisk = async (state, mtimeMs) => {
  let doc;
  try {
    doc = documents.readDocument(state.doc.path, { blockIndex: state.doc.blockIndex });
  } catch (error) {
    log.warn(`reload skipped for changed file: ${error.message}`);
    return;
  }
  state.mtimeMs = mtimeMs;
  if (doc.code === state.currentCode) {
    state.doc = doc;
    state.savedCode = doc.code;
    updateTitle(state);
    return;
  }
  if (isDirty(state) && interactive) {
    state.reloadPrompt = true;
    const { response } = await dialog.showMessageBox(state.win, {
      buttons: ['Reload from disk', 'Keep my changes'],
      cancelId: 1,
      defaultId: 1,
      detail: 'Reloading discards your unsaved changes in this window.',
      message: `${path.basename(doc.path)} was changed outside ${APP_NAME}.`,
      type: 'question'
    });
    state.reloadPrompt = false;
    if (response !== 0 || state.win.isDestroyed()) return;
  }
  loadIntoWindow(state, doc);
  log.info('reloaded document after outside change');
};

// ---------------------------------------------------------------------------
// Windows and documents

const loadIntoWindow = (state, doc) => {
  state.doc = doc;
  state.savedCode = doc.code;
  state.currentCode = doc.code;
  try {
    state.mtimeMs = fs.statSync(doc.path).mtimeMs;
  } catch {
    state.mtimeMs = undefined;
  }
  watch(state);
  if (state.ready) {
    state.win.webContents.send('mve:load-document', { code: doc.code, name: docName(state) });
  }
  updateTitle(state);
};

const createWindow = (doc) => {
  const offset = (windows.size % 8) * 28;
  const win = new BrowserWindow({
    height: 900,
    icon: ICON,
    minHeight: 400,
    minWidth: 600,
    show: false,
    title: `${APP_NAME} v${APP_VERSION}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      spellcheck: false
    },
    width: 1440,
    x: 60 + offset,
    y: 40 + offset
  });
  const state = { forceClose: false, ready: false, reloadPrompt: false, win };
  windows.set(win.webContents.id, state);
  if (doc) loadIntoWindow(state, doc);
  else updateTitle(state);

  win.on('page-title-updated', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('mve://')) {
      event.preventDefault();
      openExternal(url);
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error(`renderer gone: ${details.reason}`);
  });
  win.on('close', (event) => {
    if (state.forceClose || !isDirty(state) || !interactive) return;
    event.preventDefault();
    void confirmClose(state);
  });
  const id = win.webContents.id;
  win.on('closed', () => {
    unwatch(state);
    windows.delete(id);
    writeSmokeReport();
  });
  void win.loadURL(APP_URL);
  return state;
};

const openExternal = (url) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
};

const confirmClose = async (state) => {
  const { response } = await dialog.showMessageBox(state.win, {
    buttons: ['Save', "Don't Save", 'Cancel'],
    cancelId: 2,
    defaultId: 0,
    message: `Save changes to ${docName(state)}?`,
    type: 'warning'
  });
  if (response === 2) return;
  if (response === 0 && !(await save(state))) return;
  state.forceClose = true;
  state.win.close();
};

const chooseBlock = async (filePath, blockCount) => {
  if (blockCount <= 1 || !interactive) return 0;
  const blocks = documents
    .findMermaidBlocks(documents.decode(fs.readFileSync(filePath)).text)
    .slice(0, 8);
  const buttons = blocks.map(
    (block, index) => `Block ${index + 1}: ${block.code.trim().split('\n')[0].slice(0, 40)}`
  );
  const { response } = await dialog.showMessageBox({
    buttons: [...buttons, 'Cancel'],
    cancelId: buttons.length,
    message: `${path.basename(filePath)} contains ${blockCount} mermaid blocks. Which one do you want to edit?`,
    type: 'question'
  });
  return response === buttons.length ? -1 : response;
};

const findWindowFor = (filePath) =>
  [...windows.values()].find(
    (state) => state.doc && state.doc.path.toLowerCase() === filePath.toLowerCase()
  );

/** Opens each path in its own window. Shared by double-click, drag-onto-shortcut and File > Open. */
const openPaths = async (paths) => {
  const { valid, errors } = documents.validatePaths(paths);
  let opened = 0;
  for (const filePath of valid) {
    const existing = findWindowFor(filePath);
    if (existing && existing.doc.blockCount <= 1) {
      existing.win.show();
      existing.win.focus();
      opened++;
      continue;
    }
    try {
      let doc = documents.readDocument(filePath);
      if (doc.blockCount > 1) {
        const blockIndex = await chooseBlock(filePath, doc.blockCount);
        if (blockIndex < 0) continue;
        doc = documents.readDocument(filePath, { blockIndex });
      }
      const blank = [...windows.values()].find(
        (state) => !state.doc && state.ready && !isDirty(state)
      );
      if (blank) {
        loadIntoWindow(blank, doc);
        blank.win.focus();
      } else {
        createWindow(doc);
      }
      settings.addRecent(filePath);
      opened++;
      log.info(`opened document (${doc.kind})`);
    } catch (error) {
      errors.push({ error: error.message, file: filePath });
    }
  }
  if (errors.length > 0) {
    await showError(
      errors.length === 1 ? 'A file could not be opened.' : `${errors.length} files could not be opened.`,
      errors.map((e) => `${e.file}\n    ${e.error}`).join('\n\n')
    );
  }
  buildMenu();
  return { errors, opened };
};

const openDialog = async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    defaultPath: settings.get('lastDir'),
    filters: [
      { extensions: ['mmd', 'mermaid', 'md', 'markdown', 'txt'], name: 'Mermaid and Markdown' },
      { extensions: ['*'], name: 'All files' }
    ],
    properties: ['openFile', 'multiSelections']
  });
  if (canceled || filePaths.length === 0) return;
  settings.set('lastDir', path.dirname(filePaths[0]));
  await openPaths(filePaths);
};

const save = async (state) => {
  if (!state?.ready) return false;
  if (!state.doc) return saveAs(state);
  try {
    state.mtimeMs = documents.writeDocument(state.doc, state.currentCode);
    state.savedCode = state.currentCode;
    settings.addRecent(state.doc.path);
    log.info('saved document');
    updateTitle(state);
    return true;
  } catch (error) {
    showError('The file could not be saved.', error.message, state.win);
    return false;
  }
};

const saveAs = async (state) => {
  if (!state?.ready) return false;
  const suggested = state.doc
    ? state.doc.path.replace(/\.(md|markdown)$/i, '.mmd')
    : path.join(settings.get('lastDir') || app.getPath('documents'), 'diagram.mmd');
  const { canceled, filePath } = await dialog.showSaveDialog(state.win, {
    defaultPath: suggested,
    filters: [
      { extensions: ['mmd'], name: 'Mermaid diagram (.mmd)' },
      { extensions: ['mermaid'], name: 'Mermaid diagram (.mermaid)' },
      { extensions: ['md'], name: 'Markdown with a mermaid block (.md)' }
    ]
  });
  if (canceled || !filePath) return false;
  if (!documents.isSupportedPath(filePath)) {
    showError('Unsupported file type.', 'Use .mmd, .mermaid, .md or .txt.', state.win);
    return false;
  }
  const code = state.currentCode ?? '';
  try {
    const body = documents.isMarkdownPath(filePath)
      ? `\`\`\`mermaid\n${code.replace(/\n$/, '')}\n\`\`\`\n`
      : code;
    const temp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, body, 'utf8');
    fs.renameSync(temp, filePath);
    const doc = documents.readDocument(filePath);
    state.doc = doc;
    state.savedCode = code;
    state.mtimeMs = fs.statSync(filePath).mtimeMs;
    watch(state);
    settings.set('lastDir', path.dirname(filePath));
    settings.addRecent(filePath);
    updateTitle(state);
    buildMenu();
    return true;
  } catch (error) {
    showError('The file could not be saved.', error.message, state.win);
    return false;
  }
};

const exportSvg = async (state) => {
  if (!state?.ready) return;
  const svg = await state.win.webContents.executeJavaScript(
    `(() => { const s = document.querySelector('#container svg'); return s ? s.outerHTML : null; })()`
  );
  if (!svg) {
    showError('There is no rendered diagram to export.', 'Fix any syntax errors first.', state.win);
    return;
  }
  const base = state.doc ? state.doc.path.replace(/\.[^.\\/]+$/, '') : 'diagram';
  const { canceled, filePath } = await dialog.showSaveDialog(state.win, {
    defaultPath: `${base}.svg`,
    filters: [{ extensions: ['svg'], name: 'SVG image' }]
  });
  if (canceled || !filePath) return;
  try {
    fs.writeFileSync(filePath, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`, 'utf8');
  } catch (error) {
    showError('The SVG could not be saved.', error.message, state.win);
  }
};

// ---------------------------------------------------------------------------
// Updates

let updateBusy = false;
const declinedVersions = new Set();

const createDesktopShortcut = (target, version) => {
  const link = path.join(app.getPath('desktop'), `${APP_NAME} v${version}.lnk`);
  if (fs.existsSync(link)) return;
  const ok = shell.writeShortcutLink(link, 'create', {
    cwd: path.dirname(target),
    description: `${APP_NAME} - view and edit Mermaid diagrams`,
    icon: target,
    iconIndex: 0,
    target
  });
  if (!ok) log.warn('desktop shortcut could not be created');
};

const launchAndExit = (target) =>
  new Promise((resolve, reject) => {
    const child = spawn(target, [`--mve-wait-pid=${process.pid}`], {
      cwd: path.dirname(target),
      detached: true,
      stdio: 'ignore'
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

const runUpdateCheck = async ({ manual = false } = {}) => {
  if (updateBusy) return;
  if (!app.isPackaged) {
    if (manual) void dialog.showMessageBox({ message: 'Updates are only checked in the packaged app.' });
    return;
  }
  updateBusy = true;
  let approved = false;
  try {
    const info = await updater.checkForUpdate({ appDir, currentVersion: APP_VERSION });
    if (!info) {
      if (manual) {
        void dialog.showMessageBox({ message: `${APP_NAME} v${APP_VERSION} is up to date.`, title: APP_NAME });
      }
      return;
    }
    const { version, release_notes } = info.manifest;
    if (!interactive || (!manual && declinedVersions.has(version))) return;
    const { response } = await dialog.showMessageBox({
      buttons: ['Install now', 'Later'],
      cancelId: 1,
      defaultId: 0,
      detail: release_notes,
      message: `Version ${version} is available. Install now?`,
      title: APP_NAME,
      type: 'question'
    });
    if (response !== 0) {
      declinedVersions.add(version);
      return;
    }
    approved = true;
    if ([...windows.values()].some(isDirty)) {
      await dialog.showMessageBox({
        message: 'Save or close your edited diagrams first, then choose Help > Check for Updates.',
        title: APP_NAME
      });
      return;
    }
    const installed = await updater.installUpdate(info);
    log.info(`installed update ${version}`);
    createDesktopShortcut(installed, version);
    await launchAndExit(installed);
    for (const state of windows.values()) state.forceClose = true;
    app.quit();
  } catch (error) {
    // Background checks stay quiet (Dropbox may still be syncing); they retry in 30 minutes.
    log.warn(`update: ${error.message}`);
    if (manual || approved) void showError('Update failed.', error.message);
  } finally {
    updateBusy = false;
  }
};

// ---------------------------------------------------------------------------
// Menu

// Runs a page command with a user gesture (the page needs one to enter full screen).
const pageCommand = (command) => (state) => {
  if (!state.ready) return;
  void state.win.webContents
    .executeJavaScript(`window.mveCommand?.(${JSON.stringify(command)})`, true)
    .catch((error) => log.warn(`page command ${command}: ${error.message}`));
};

const buildMenu = () => {
  const withState = (fn) => () => {
    const state = focusedState();
    if (state) void fn(state);
  };
  const recent = settings.recentFiles;
  const template = [
    {
      label: '&File',
      submenu: [
        { accelerator: 'CmdOrCtrl+N', click: () => createWindow(), label: 'New Window' },
        { accelerator: 'CmdOrCtrl+O', click: () => void openDialog(), label: 'Open...' },
        {
          label: 'Open Recent',
          submenu:
            recent.length === 0
              ? [{ enabled: false, label: '(none)' }]
              : [
                  ...recent.map((file) => ({ click: () => void openPaths([file]), label: file })),
                  { type: 'separator' },
                  {
                    click: () => {
                      settings.clearRecent();
                      buildMenu();
                    },
                    label: 'Clear Recent'
                  }
                ]
        },
        { type: 'separator' },
        { accelerator: 'CmdOrCtrl+S', click: withState(save), label: 'Save' },
        { accelerator: 'CmdOrCtrl+Shift+S', click: withState(saveAs), label: 'Save As...' },
        { click: withState(exportSvg), label: 'Export SVG...' },
        { type: 'separator' },
        { accelerator: 'CmdOrCtrl+W', label: 'Close Window', role: 'close' },
        { label: 'Exit', role: 'quit' }
      ]
    },
    { label: '&Edit', role: 'editMenu' },
    {
      label: '&View',
      submenu: [
        { accelerator: 'CmdOrCtrl+B', click: withState(pageCommand('toggle-editor')), label: 'Toggle Editor Pane' },
        { accelerator: 'F11', click: withState(pageCommand('toggle-fullscreen')), label: 'Diagram Full Screen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        {
          click: () => openExternal('https://mermaid.js.org/intro/syntax-reference.html'),
          label: 'Mermaid Syntax Reference'
        },
        { click: () => void runUpdateCheck({ manual: true }), label: 'Check for Updates' },
        { click: () => void shell.openPath(path.dirname(log.file)), label: 'Open Log Folder' },
        { type: 'separator' },
        {
          click: () =>
            void dialog.showMessageBox({
              detail: [
                'Desktop edition of the open-source Mermaid Live Editor (MIT license).',
                'https://github.com/mermaid-js/mermaid-live-editor',
                '',
                `Settings and logs: ${DATA_DIR}`
              ].join('\n'),
              icon: ICON,
              message: `${APP_NAME} v${APP_VERSION}`,
              title: 'About'
            }),
          label: 'About'
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

// ---------------------------------------------------------------------------
// IPC from the editor page

ipcMain.handle('mve:ready', (event) => {
  const state = stateFor(event.sender);
  if (!state) return undefined;
  state.ready = true;
  // Untitled windows: the first reported code becomes the unmodified baseline.
  if (!state.doc) state.savedCode = undefined;
  writeSmokeReport();
  if (SMOKE_REPORT) {
    // Test hook: capture what the window actually rendered.
    const shot = `${SMOKE_REPORT}.${event.sender.id}.png`;
    setTimeout(() => {
      if (state.win.isDestroyed()) return;
      void state.win.webContents
        .capturePage()
        .then((image) => fs.writeFileSync(shot, image.toPNG()))
        .catch((error) => log.warn(`screenshot: ${error.message}`));
    }, 4000);
    if (process.env.MVE_SMOKE_COMMANDS) {
      // Test hook: run page commands (comma separated) and screenshot after each.
      const commands = process.env.MVE_SMOKE_COMMANDS.split(',');
      smoke.commands = [];
      commands.forEach((command, index) => {
        setTimeout(async () => {
          if (state.win.isDestroyed()) return;
          pageCommand(command)(state);
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const image = await state.win.webContents.capturePage();
          fs.writeFileSync(`${SMOKE_REPORT}.cmd${index + 1}.png`, image.toPNG());
          smoke.commands.push({ command, windowFullScreen: state.win.isFullScreen() });
          writeSmokeReport();
        }, 6000 + index * 4000);
      });
    }
    if (process.env.MVE_SMOKE_EDIT && state.doc) {
      // Test hook: type into the real editor, then run the same save as File > Save.
      setTimeout(async () => {
        const wc = state.win.webContents;
        state.win.focus();
        const rect = await wc.executeJavaScript(
          `(() => { const r = document.querySelector('.monaco-editor .view-lines').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + 10) }; })()`
        );
        wc.sendInputEvent({ button: 'left', clickCount: 1, type: 'mouseDown', ...rect });
        wc.sendInputEvent({ button: 'left', clickCount: 1, type: 'mouseUp', ...rect });
        wc.debugger.attach('1.3');
        const key = (type, extra) =>
          wc.debugger.sendCommand('Input.dispatchKeyEvent', { type, ...extra });
        await key('rawKeyDown', { code: 'End', key: 'End', modifiers: 2, windowsVirtualKeyCode: 35 });
        await key('keyUp', { code: 'End', key: 'End', modifiers: 2, windowsVirtualKeyCode: 35 });
        await wc.debugger.sendCommand('Input.insertText', { text: process.env.MVE_SMOKE_EDIT });
        wc.debugger.detach();
        setTimeout(async () => {
          smoke.editorText = await wc.executeJavaScript(
            `document.querySelector('.monaco-editor .view-lines')?.innerText ?? 'NO EDITOR'`
          );
          smoke.focused = await wc.executeJavaScript(`document.activeElement?.className ?? ''`);
          smoke.dirtyBeforeSave = isDirty(state);
          smoke.saved = await save(state);
          smoke.dirtyAfterSave = isDirty(state);
          writeSmokeReport();
        }, 1500);
      }, 5000);
    }
  }
  return state.doc ? { code: state.doc.code, name: docName(state) } : undefined;
});

ipcMain.on('mve:code-changed', (event, code) => {
  const state = stateFor(event.sender);
  if (!state || typeof code !== 'string') return;
  state.currentCode = code;
  if (state.savedCode === undefined) state.savedCode = code;
  updateTitle(state);
});

// ---------------------------------------------------------------------------
// App lifecycle

const resolveWebFile = (pathname) => {
  const relative = path.normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, '');
  const candidate = path.join(WEB_DIR, relative);
  if (candidate !== WEB_DIR && !candidate.startsWith(WEB_DIR + path.sep)) return undefined;
  for (const option of [candidate, `${candidate}.html`, path.join(candidate, 'index.html')]) {
    try {
      if (fs.statSync(option).isFile()) return option;
    } catch {
      // try the next option
    }
  }
  return path.join(WEB_DIR, '404.html');
};

app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
  const files = Array.isArray(additionalData?.files)
    ? additionalData.files
    : documents.filesFromArgv(argv, { cwd: workingDirectory, skip: argvSkip });
  if (files.length > 0) void openPaths(files);
  else createWindow();
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  log.info(`start v${APP_VERSION} (${initialFiles.length} file argument(s))`);
  protocol.handle('mve', (request) => {
    const file = resolveWebFile(new URL(request.url).pathname);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const { session } = require('electron');
  session.defaultSession.on('will-download', (_event, item, webContents) => {
    const state = stateFor(webContents);
    const ext = path.extname(item.getFilename()) || '.png';
    const base = state?.doc ? state.doc.path.replace(/\.[^.\\/]+$/, '') : path.join(app.getPath('downloads'), 'diagram');
    item.setSaveDialogOptions({ defaultPath: `${base}${ext}` });
  });
  buildMenu();
  if (initialFiles.length > 0) {
    const { opened } = await openPaths(initialFiles);
    // Every dropped file failed: the error summary was shown, nothing to keep open.
    if (opened === 0 && windows.size === 0) {
      writeSmokeReport();
      app.quit();
      return;
    }
  } else {
    createWindow();
  }
  setTimeout(() => void runUpdateCheck(), FIRST_UPDATE_CHECK_MS);
  setInterval(() => void runUpdateCheck(), UPDATE_INTERVAL_MS);
});

process.on('uncaughtException', (error) => log.error(`uncaught: ${error.stack}`));
process.on('unhandledRejection', (error) => log.error(`unhandled: ${error?.stack ?? error}`));
