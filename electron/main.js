import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DesktopWindowManager } from './desktopWindow.js';
import { ServerConfigController, getHostForUrl, getOriginForUrl } from './serverConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_NAME = 'CloudCLI';
const APP_USER_MODEL_ID = 'ai.cloudcli.desktop';
const DEFAULT_SERVER_URL = process.env.CLOUDCLI_DEFAULT_SERVER_URL || 'https://dev.nesar.dev';
const MAX_PANES = 4;
const VALID_LAYOUTS = new Set([1, 2, 3, 4]);

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// ---------------------------------------------------------------------------
// Workspace model: a layout (how many panes) + the panes themselves. Each pane
// holds a session URL (or is empty). The grid IS the view — no tab switching.
// ---------------------------------------------------------------------------
let serverConfig = null;
let desktopWindow = null;

let connected = false;
let layout = 1;
let panes = []; // [{ id, url, title }]  url null = empty pane
let activePaneId = null;
let paneSeq = 0;

function nextPaneId() {
  paneSeq += 1;
  return `pane-${paneSeq}`;
}

function makePane(url = null) {
  return { id: nextPaneId(), url, title: url ? getHostForUrl(url) : '' };
}

function getAppRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function getLauncherPath() {
  return path.join(__dirname, 'launcher', 'index.html');
}

function getPreloadPath() {
  return path.join(__dirname, 'preload.cjs');
}

function getWindowIconPath() {
  if (process.platform === 'darwin') {
    return path.join(getAppRoot(), 'electron', 'assets', 'logo-macos.png');
  }
  return path.join(getAppRoot(), 'public', 'logo-512.png');
}

function getServerConfigPath() {
  return path.join(app.getPath('userData'), 'server-config.json');
}

/** Origins the loaded web app may request permissions from. */
function getAllowedOrigins() {
  const origins = ['http://127.0.0.1', 'http://localhost'];
  const push = (url) => {
    const origin = getOriginForUrl(url);
    if (origin && !origins.includes(origin)) origins.push(origin);
  };
  push(serverConfig?.getUrl());
  for (const recent of serverConfig?.getRecents() || []) push(recent);
  return origins;
}

function getActivePaneId() {
  if (activePaneId && panes.some((pane) => pane.id === activePaneId)) return activePaneId;
  return panes[0]?.id || null;
}

function getDesktopState() {
  return {
    serverUrl: serverConfig?.getUrl() || null,
    recentServers: serverConfig?.getRecents() || [],
    defaultServerUrl: DEFAULT_SERVER_URL,
    connected,
    layout,
    maxPanes: MAX_PANES,
    activePaneId: getActivePaneId(),
    panes: panes.map((pane) => ({ id: pane.id, url: pane.url, title: pane.title })),
    // Geometry must ride along with EVERY state response — IPC handlers (e.g.
    // set-layout) resolve to this, and the renderer draws pane headers/empty
    // cards from state.geometry. Omitting it caused a race where the IPC reply
    // (no geometry) clobbered the event render (with geometry) → blank panes.
    geometry: (desktopWindow && desktopWindow.getLastGeometry)
      ? desktopWindow.getLastGeometry()
      : null,
  };
}

/** Push the current model into the window (tiles the BrowserViews). */
function renderWorkspace() {
  if (!desktopWindow) return;
  if (!connected) {
    desktopWindow.showConnectScreen();
  } else {
    desktopWindow.applyWorkspace({ layout, panes, activePaneId: getActivePaneId() });
  }
  desktopWindow.buildAppMenu();
  desktopWindow.emitDesktopState();
}

function syncDesktopState() {
  if (!desktopWindow) return;
  desktopWindow.buildAppMenu();
  desktopWindow.emitDesktopState();
}

async function openExternalUrl(url) {
  await shell.openExternal(url);
}

async function showError(title, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${title}: ${message}`);
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'error',
    title,
    message: title,
    detail: message,
  });
}

function ensurePaneCount(count) {
  const target = Math.max(1, Math.min(MAX_PANES, count));
  while (panes.length < target) panes.push(makePane());
  if (panes.length > target) panes = panes.slice(0, target);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Connect to a server: persist it, open it in pane 1, show the grid. */
async function connectToServer(rawUrl, requestedLayout = 1) {
  await serverConfig.save(rawUrl);
  layout = VALID_LAYOUTS.has(requestedLayout) ? requestedLayout : 1;
  // Every pane starts empty + uniform (Open / New card) — no special first pane.
  panes = [makePane()];
  ensurePaneCount(layout);
  activePaneId = panes[0].id;
  connected = true;
  renderWorkspace();
  return getDesktopState();
}

function setLayout(nextLayout) {
  if (!VALID_LAYOUTS.has(Number(nextLayout))) return getDesktopState();
  layout = Number(nextLayout);
  ensurePaneCount(layout);
  renderWorkspace();
  return getDesktopState();
}

// Desktop panes already ARE the grid, so the web app must render single-view
// inside them (never nest a web grid). `?solo=1` tells the web app to do that.
function withSolo(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('solo', '1');
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Point a pane at a session URL (fill or swap). */
function setPaneUrl(paneId, url) {
  const pane = panes.find((item) => item.id === paneId);
  if (!pane) return getDesktopState();
  pane.url = url ? withSolo(url) : null;
  pane.title = url ? getHostForUrl(url) : '';
  activePaneId = paneId;
  renderWorkspace();
  return getDesktopState();
}

function focusPane(paneId) {
  if (panes.some((pane) => pane.id === paneId)) {
    activePaneId = paneId;
    renderWorkspace();
  }
  return getDesktopState();
}

// Fired when a pane's web contents gains focus (user clicked into it). Move the
// active-pane accent + titlebar controls to it. Guarded so tiling's own focus()
// call (on the already-active pane) doesn't cause a render loop.
function onPaneFocus(paneId) {
  if (paneId === getActivePaneId()) return;
  if (!panes.some((pane) => pane.id === paneId)) return;
  activePaneId = paneId;
  renderWorkspace();
}

/** Expand one pane to fill the window (1-up), remembering nothing fancy. */
function expandPane(paneId) {
  const pane = panes.find((item) => item.id === paneId);
  if (!pane) return getDesktopState();
  panes = [pane];
  layout = 1;
  activePaneId = pane.id;
  renderWorkspace();
  return getDesktopState();
}

function clearPane(paneId) {
  const pane = panes.find((item) => item.id === paneId);
  if (!pane) return getDesktopState();
  pane.url = null;
  pane.title = '';
  renderWorkspace();
  return getDesktopState();
}

function reloadPane(paneId) {
  desktopWindow?.reloadPane(paneId || getActivePaneId());
  return getDesktopState();
}

async function showConnectScreen() {
  connected = false;
  renderWorkspace();
  return getDesktopState();
}

async function connectRecent(url) {
  return connectToServer(url, layout);
}

async function forgetServer(rawUrl) {
  await serverConfig.forget(rawUrl);
  syncDesktopState();
  return getDesktopState();
}

/** viewHost tells us a pane's page title changed → reflect it in the header. */
function onPaneUpdate(paneId, info) {
  const pane = panes.find((item) => item.id === paneId);
  if (!pane) return;
  if (info?.title) pane.title = info.title;
  if (info?.url) pane.url = info.url;
  syncDesktopState();
}

// ---------------------------------------------------------------------------
// Server API (projects/sessions) — authed with the JWT the web app stored in a
// logged-in pane's localStorage. Lets the shell fill a pane with an exact
// session (`<server>/session/<id>`) without using the in-pane sidebar.
// ---------------------------------------------------------------------------
async function apiFetch(pathname) {
  const base = serverConfig?.getUrl();
  if (!base) throw new Error('Not connected to a server.');
  const token = await desktopWindow?.readAuthTokenForOrigin(base);
  if (!token) throw new Error('Sign in to a pane first so the app can list your projects.');
  const res = await fetch(base + pathname, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Server returned ${res.status} for ${pathname}`);
  return res.json();
}

async function listProjects() {
  const data = await apiFetch('/api/projects');
  const arr = Array.isArray(data) ? data : (data.projects || []);
  return arr.map((p) => ({
    id: p.projectId || p.name || p.id || p.path,
    label: p.displayName || p.projectId || p.path || p.name,
    // Sessions come embedded in /api/projects — no N+1 fetch needed.
    sessions: (p.sessions || []).map((s) => ({
      id: s.id,
      label: s.summary || s.title || s.name || s.id,
      provider: s.provider || null,
      lastActivity: s.lastActivity || s.updatedAt || s.updated_at || null,
    })).filter((s) => s.id),
  })).filter((p) => p.id);
}

async function listSessions(projectId) {
  const data = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions?limit=50&offset=0`);
  const arr = data.sessions || (Array.isArray(data) ? data : []);
  return arr.map((s) => ({
    id: s.id,
    label: s.title || s.summary || s.name || s.id,
    provider: s.provider || s.__provider || null,
  })).filter((s) => s.id);
}

function openSessionInPane(paneId, sessionId) {
  const base = serverConfig?.getUrl();
  if (!base || !sessionId) return getDesktopState();
  return setPaneUrl(paneId, `${base}/session/${encodeURIComponent(sessionId)}`);
}

// Open a fresh new-session composer for a project in a pane. The web reads
// `?newProject=<id>` (and `?solo` via withSolo) and shows the composer without
// needing the in-pane sidebar.
function newSessionInPane(paneId, projectId) {
  const base = serverConfig?.getUrl();
  if (!base) return getDesktopState();
  const url = projectId ? `${base}/?newProject=${encodeURIComponent(projectId)}` : base;
  return setPaneUrl(paneId, url);
}

function getDiagnosticsText() {
  return JSON.stringify({
    app: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    mode: 'remote-client',
    serverUrl: serverConfig?.getUrl() || null,
    recentServers: serverConfig?.getRecents() || [],
    layout,
    panes: panes.map((pane) => ({ id: pane.id, url: pane.url, title: pane.title })),
    userDataPath: app.getPath('userData'),
    serverConfigPath: getServerConfigPath(),
  }, null, 2);
}

async function copyDiagnostics() {
  clipboard.writeText(getDiagnosticsText());
  await dialog.showMessageBox(desktopWindow?.getMainWindow() || undefined, {
    type: 'info',
    title: 'Diagnostics copied',
    message: 'CloudCLI desktop diagnostics were copied to the clipboard.',
  });
}

function registerIpcHandlers() {
  ipcMain.handle('cloudcli-desktop:get-state', () => getDesktopState());
  ipcMain.handle('cloudcli-desktop:connect-server', async (_event, url, requestedLayout) =>
    connectToServer(url, Number(requestedLayout) || 1));
  ipcMain.handle('cloudcli-desktop:connect-recent', async (_event, url) => connectRecent(url));
  ipcMain.handle('cloudcli-desktop:show-connect-screen', async () => showConnectScreen());
  ipcMain.handle('cloudcli-desktop:forget-server', async (_event, url) => forgetServer(url));
  ipcMain.handle('cloudcli-desktop:set-layout', async (_event, nextLayout) => setLayout(nextLayout));
  ipcMain.handle('cloudcli-desktop:set-pane-url', async (_event, paneId, url) => setPaneUrl(paneId, url));
  ipcMain.handle('cloudcli-desktop:focus-pane', async (_event, paneId) => focusPane(paneId));
  ipcMain.handle('cloudcli-desktop:expand-pane', async (_event, paneId) => expandPane(paneId));
  ipcMain.handle('cloudcli-desktop:clear-pane', async (_event, paneId) => clearPane(paneId));
  ipcMain.handle('cloudcli-desktop:reload-pane', async (_event, paneId) => reloadPane(paneId));
  ipcMain.handle('cloudcli-desktop:list-projects', async () => listProjects());
  ipcMain.handle('cloudcli-desktop:list-sessions', async (_event, projectId) => listSessions(projectId));
  ipcMain.handle('cloudcli-desktop:open-session-in-pane', async (_event, paneId, sessionId) =>
    openSessionInPane(paneId, sessionId));
  ipcMain.handle('cloudcli-desktop:new-session-in-pane', async (_event, paneId, projectId) =>
    newSessionInPane(paneId, projectId));
  ipcMain.handle('cloudcli-desktop:set-overlay', async (_event, active) => {
    if (active) desktopWindow?.detachPanes();
    else renderWorkspace();
    return getDesktopState();
  });
  ipcMain.handle('cloudcli-desktop:read-auth-token', async () => {
    const url = serverConfig?.getUrl();
    if (!url) return null;
    return desktopWindow?.readAuthTokenForOrigin(url) || null;
  });
  ipcMain.handle('cloudcli-desktop:copy-diagnostics', async () => {
    await copyDiagnostics();
    return getDesktopState();
  });
  ipcMain.handle('cloudcli-desktop:open-external', async (_event, url) => {
    await openExternalUrl(url);
    return getDesktopState();
  });
}

function registerAppEvents() {
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (desktopWindow) {
        void desktopWindow.createWindow();
      } else {
        void createDesktopWindow();
      }
      return;
    }
    const window = desktopWindow?.getMainWindow();
    if (window) {
      window.show();
      window.focus();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

async function createDesktopWindow() {
  desktopWindow = new DesktopWindowManager({
    appName: APP_NAME,
    getWindowIconPath,
    getLauncherPath,
    getPreloadPath,
    openExternalUrl,
    getDesktopState,
    getAllowedOrigins,
    onPaneUpdate,
    onPaneFocus,
    onResize: () => renderWorkspace(),
    actions: {
      copyDiagnostics,
      copyText: (text) => clipboard.writeText(text),
      showConnectScreen,
      setLayout,
      reloadPane,
      showError,
    },
  });

  desktopWindow.createTray();
  desktopWindow.configurePermissions();
  await desktopWindow.createWindow();
}

function registerSingleInstance() {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    const window = desktopWindow?.getMainWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  return true;
}

async function bootstrap() {
  app.name = APP_NAME;
  app.setName(APP_NAME);
  process.title = APP_NAME;

  await app.whenReady();
  app.setName(APP_NAME);
  // Pin userData to our app name so dev + packaged builds share one config dir
  // (unpackaged Electron otherwise falls back to ~/.config/Electron).
  try {
    app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
  } catch (error) {
    console.error('Could not pin userData path:', error?.message || error);
  }
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'CloudCLI',
  });

  serverConfig = new ServerConfigController({
    storePath: getServerConfigPath(),
    onChange: syncDesktopState,
  });
  await serverConfig.load();

  registerIpcHandlers();
  registerAppEvents();
  await createDesktopWindow();

  // Auto-connect to the last-used server; otherwise show the connect screen.
  const savedUrl = serverConfig.getUrl();
  if (process.env.CLOUDCLI_DEBUG) {
    console.error('[boot] userData=%s configPath=%s savedUrl=%s',
      app.getPath('userData'), getServerConfigPath(), String(savedUrl));
  }
  if (savedUrl) {
    try {
      await connectToServer(savedUrl, layout);
      if (process.env.CLOUDCLI_DEBUG) console.error('[boot] connected -> %s', savedUrl);
    } catch (error) {
      console.error('Auto-connect failed:', error?.message || error);
      await showConnectScreen();
    }
  } else {
    await showConnectScreen();
  }
}

if (registerSingleInstance()) {
  bootstrap().catch(async (error) => {
    await showError('CloudCLI failed to start', error);
    app.quit();
  });
}
