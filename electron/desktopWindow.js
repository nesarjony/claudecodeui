import { BrowserWindow, Menu, Tray, clipboard, nativeImage, nativeTheme, session } from 'electron';

import { ViewHost } from './viewHost.js';

const TITLEBAR_HEIGHT = 30;   // slim: just traffic lights + compact controls
const PANE_HEADER_HEIGHT = 0;  // no per-pane header strip (app shows its own)
const GUTTER = 2;              // thin frame around each pane (focus accent)
const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

// The web app's persistent desktop sidebar wrapper (AppContent.tsx:
// `<div class="h-full flex-shrink-0 border-r border-border/50">`). Hidden so
// panes are full-bleed chat — nav happens via the shell picker + in-app ⌘K.
const SIDEBAR_HIDE_CSS = `
.fixed.inset-0.flex.bg-background > .flex-shrink-0.border-r { display: none !important; }
`;

// Always-injected desktop style tweaks for the loaded web app:
//  - strip sidebar clutter (GitHub star badge, Report Issue, Discord, OSS line)
//  - user's sent chat messages: colored text only, no blue bubble background
const DESKTOP_OVERRIDE_CSS = `
a[href*="discord.gg"],
a[href*="/issues/new"],
a[href="https://github.com/siteboon/claudecodeui"],
[class~="group/star"] { display: none !important; }

.chat-message.user .bg-blue-600.rounded-2xl {
  background-color: transparent !important;
  box-shadow: none !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  color: #4b96ff !important;
}
.chat-message.user .bg-blue-600.rounded-2xl .text-blue-100 { color: #8b97a8 !important; }
`;

// Fractional cell rectangles per layout. Index maps to pane index.
const LAYOUT_RECTS = {
  1: [{ x: 0, y: 0, w: 1, h: 1 }],
  2: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }],
  3: [
    { x: 0, y: 0, w: 0.5, h: 1 },
    { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ],
  4: [
    { x: 0, y: 0, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ],
};

export class DesktopWindowManager {
  constructor({
    appName,
    getWindowIconPath,
    getLauncherPath,
    getPreloadPath,
    openExternalUrl,
    getDesktopState,
    getAllowedOrigins,
    onPaneUpdate,
    onPaneFocus,
    onResize,
    actions,
  }) {
    this.appName = appName;
    this.getWindowIconPath = getWindowIconPath;
    this.getLauncherPath = getLauncherPath;
    this.getPreloadPath = getPreloadPath;
    this.openExternalUrl = openExternalUrl;
    this.getDesktopState = getDesktopState;
    this.getAllowedOrigins = getAllowedOrigins;
    this.onResize = onResize || (() => {});
    this.actions = actions;

    this.mainWindow = null;
    this.tray = null;
    this.launcherLoaded = false;
    this.lastGeometry = null;
    this.connected = false;

    this.viewHost = new ViewHost({
      getMainWindow: () => this.mainWindow,
      getPreloadPath: this.getPreloadPath,
      openExternalUrl: this.openExternalUrl,
      showError: this.actions.showError,
      onPaneUpdate,
      onPaneFocus,
    });
    this.viewHost.setSidebarHideCss(SIDEBAR_HIDE_CSS);
    this.viewHost.setOverrideCss(DESKTOP_OVERRIDE_CSS);
  }

  getMainWindow() {
    return this.mainWindow;
  }

  getTrayImage() {
    const image = nativeImage.createFromPath(this.getWindowIconPath());
    return image.resize({ width: 18, height: 18 });
  }

  getContentBounds() {
    if (!this.mainWindow) return { x: 0, y: TITLEBAR_HEIGHT, width: 0, height: 0 };
    const [width, height] = this.mainWindow.getContentSize();
    return { x: 0, y: TITLEBAR_HEIGHT, width, height: Math.max(0, height - TITLEBAR_HEIGHT) };
  }

  computeGeometry(layout, paneCount, content) {
    const rects = LAYOUT_RECTS[layout] || LAYOUT_RECTS[1];
    const headerH = layout === 1 ? 0 : PANE_HEADER_HEIGHT;
    const cells = [];
    for (let i = 0; i < paneCount; i += 1) {
      const frac = rects[i] || rects[rects.length - 1];
      const cellX = Math.round(content.x + frac.x * content.width);
      const cellY = Math.round(content.y + frac.y * content.height);
      const cellW = Math.round(frac.w * content.width);
      const cellH = Math.round(frac.h * content.height);
      const headerRect = { x: cellX, y: cellY, width: cellW, height: headerH };
      const viewBounds = {
        x: cellX + GUTTER,
        y: cellY + headerH + GUTTER,
        width: Math.max(0, cellW - GUTTER * 2),
        height: Math.max(0, cellH - headerH - GUTTER * 2),
      };
      cells.push({ index: i, cellRect: { x: cellX, y: cellY, width: cellW, height: cellH }, headerRect, viewBounds });
    }
    return cells;
  }

  /** Tile the panes; render pane-header chrome from the launcher layer. */
  applyWorkspace({ layout, panes, activePaneId }) {
    this.connected = true;
    if (!this.mainWindow) return;

    const content = this.getContentBounds();
    const cells = this.computeGeometry(layout, panes.length, content);

    // Non-empty panes get a live BrowserView; empty panes show a launcher placeholder.
    const viewPanes = [];
    const geometryPanes = panes.map((pane, index) => {
      const cell = cells[index];
      const empty = !pane.url;
      if (!empty) {
        viewPanes.push({
          id: pane.id,
          url: pane.url,
          bounds: cell.viewBounds,
          active: pane.id === activePaneId,
        });
      }
      return {
        id: pane.id,
        title: pane.title || '',
        url: pane.url || null,
        empty,
        active: pane.id === activePaneId,
        headerRect: cell.headerRect,
        cellRect: cell.cellRect,
        viewBounds: cell.viewBounds,
      };
    });

    void this.viewHost.syncPanes(viewPanes);
    this.lastGeometry = {
      titlebarHeight: TITLEBAR_HEIGHT,
      paneHeaderHeight: layout === 1 ? 0 : PANE_HEADER_HEIGHT,
      layout,
      panes: geometryPanes,
    };

    const activePane = panes.find((pane) => pane.id === activePaneId) || panes[0];
    const titleName = layout === 1 && activePane?.title ? activePane.title : this.appName;
    this.mainWindow.setTitle(`${this.appName} — ${titleName}`);
    this.buildAppMenu();
    this.emitDesktopState();
  }

  showConnectScreen() {
    this.connected = false;
    this.lastGeometry = null;
    this.viewHost.detachAll();
    if (this.mainWindow) {
      this.mainWindow.setTitle(this.appName);
      this.mainWindow.webContents.focus();
    }
    this.buildAppMenu();
    this.emitDesktopState();
  }

  reloadPane(paneId) {
    return this.viewHost.reloadPane(paneId);
  }

  // Detach the live panes so a launcher-drawn modal (picker) can render above
  // them — BrowserViews always sit above the window's HTML. Re-tiled on close.
  detachPanes() {
    this.viewHost.detachAll();
  }

  openActivePaneDevTools() {
    if (this.viewHost.openPaneDevTools()) return;
    void this.actions.showError('No active pane', new Error('Connect and focus a pane first.'));
  }

  async readAuthTokenForOrigin(originUrl) {
    return this.viewHost.readLocalStorageValueForOrigin(originUrl, AUTH_TOKEN_STORAGE_KEY);
  }

  getLastGeometry() {
    return this.lastGeometry;
  }

  emitDesktopState() {
    if (!this.mainWindow || this.mainWindow.webContents.isDestroyed()) return;
    const state = { ...this.getDesktopState(), geometry: this.lastGeometry };
    this.mainWindow.webContents.send('cloudcli-desktop:state-updated', state);
  }

  buildAppMenu() {
    if (!this.mainWindow) return;
    const state = this.getDesktopState();
    const recents = state.recentServers || [];
    const recentItems = recents.length
      ? recents.map((url) => ({
          label: url,
          click: () => void this.actions.showConnectScreen(),
        }))
      : [{ label: 'No recent servers', enabled: false }];

    const layoutItem = (n, label, accel) => ({
      label,
      accelerator: accel,
      type: 'checkbox',
      checked: state.layout === n,
      enabled: state.connected,
      click: () => this.actions.setLayout(n),
    });

    const template = [
      {
        label: this.appName,
        submenu: [
          { label: `About ${this.appName}`, role: 'about' },
          { type: 'separator' },
          {
            label: 'Change Server…',
            accelerator: 'CmdOrCtrl+Shift+O',
            click: () => void this.actions.showConnectScreen(),
          },
          { label: 'Copy Diagnostics', click: () => void this.actions.copyDiagnostics() },
          { type: 'separator' },
          { label: process.platform === 'darwin' ? `Hide ${this.appName}` : 'Hide', role: 'hide' },
          { label: 'Hide Others', role: 'hideOthers', visible: process.platform === 'darwin' },
          { type: 'separator' },
          { label: `Quit ${this.appName}`, accelerator: 'CmdOrCtrl+Q', role: 'quit' },
        ],
      },
      {
        label: 'Layout',
        submenu: [
          layoutItem(1, 'Single Pane', 'CmdOrCtrl+1'),
          layoutItem(2, 'Two Panes', 'CmdOrCtrl+2'),
          layoutItem(3, 'Three Panes', 'CmdOrCtrl+3'),
          layoutItem(4, 'Four Panes (Grid)', 'CmdOrCtrl+4'),
          { type: 'separator' },
          {
            label: 'Reload Focused Pane',
            accelerator: 'CmdOrCtrl+R',
            enabled: state.connected,
            click: () => this.actions.reloadPane(null),
          },
        ],
      },
      {
        label: 'Server',
        submenu: [
          { label: 'Change Server…', click: () => void this.actions.showConnectScreen() },
          { type: 'separator' },
          { label: 'Recent Servers', submenu: recentItems },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Reload Focused Pane', accelerator: 'CmdOrCtrl+R', click: () => this.actions.reloadPane(null) },
          { label: 'Focused Pane DevTools', click: () => this.openActivePaneDevTools() },
          { role: 'toggleDevTools', label: 'Shell DevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front' }] : []),
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    this.buildTrayMenu();
  }

  buildTrayMenu() {
    if (!this.tray) return;
    const state = this.getDesktopState();
    const template = [
      {
        label: state.connected ? `Connected: ${state.serverUrl}` : 'Not connected',
        enabled: false,
      },
      { type: 'separator' },
      { label: 'Change Server…', click: () => void this.actions.showConnectScreen() },
      { label: 'Show Window', click: () => this.mainWindow?.show() },
      { type: 'separator' },
      { label: `Quit ${this.appName}`, role: 'quit' },
    ];
    this.tray.setToolTip(`${this.appName}${state.serverUrl ? ` — ${state.serverUrl}` : ''}`);
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  configurePermissions() {
    const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'media', 'notifications']);
    const isAllowed = (contents, permission) => {
      if (!contents) return false;
      let origin;
      try {
        origin = new URL(contents.getURL()).origin;
      } catch {
        return false;
      }
      return this.getAllowedOrigins().includes(origin) && allowed.has(permission);
    };
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(isAllowed(contents, permission));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission) => isAllowed(contents, permission));
  }

  createTray() {
    if (this.tray) return;
    try {
      this.tray = new Tray(this.getTrayImage());
    } catch (error) {
      // Headless / no system tray (e.g. bare Linux) — the app still works.
      console.warn('[Tray] unavailable:', error?.message || error);
      this.tray = null;
      return;
    }
    this.tray.on('click', () => {
      if (!this.mainWindow) return;
      if (this.mainWindow.isVisible()) this.mainWindow.focus();
      else this.mainWindow.show();
    });
    this.buildTrayMenu();
  }

  async createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 900,
      minHeight: 640,
      show: false,
      backgroundColor: '#0b0f17',
      title: this.appName,
      icon: this.getWindowIconPath(),
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 12, y: 8 } }
        : {
            titleBarOverlay: {
              color: nativeTheme.shouldUseDarkColors ? '#0b0f17' : '#f7f8fa',
              symbolColor: nativeTheme.shouldUseDarkColors ? '#a1a1a1' : '#5b6470',
              height: TITLEBAR_HEIGHT,
            },
          }),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });

    this.mainWindow.once('ready-to-show', () => this.mainWindow?.show());

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternalUrl(url).catch((error) => this.actions.showError('Could not open external link', error));
      return { action: 'deny' };
    });

    let resizeTimer = null;
    this.mainWindow.on('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => this.onResize(), 60);
    });

    this.mainWindow.on('closed', () => {
      this.viewHost.clear();
      this.mainWindow = null;
      this.launcherLoaded = false;
    });

    await this.mainWindow.loadFile(this.getLauncherPath());
    this.launcherLoaded = true;
    this.buildAppMenu();
    this.emitDesktopState();
  }
}
