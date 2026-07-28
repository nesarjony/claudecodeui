import { BrowserView } from 'electron';

const TARGET_LOAD_TIMEOUT_MS = 20000;

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isExpectedNavigationAbort(error) {
  const message = error instanceof Error ? error.message : String(error);
  return error?.code === 'ERR_ABORTED' || message.includes('ERR_ABORTED') || message.includes('(-3)');
}

async function loadUrlWithTimeout(webContents, url, timeoutMs = TARGET_LOAD_TIMEOUT_MS) {
  let timedOut = false;
  let timeout = null;
  const loadPromise = webContents.loadURL(url);
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      try {
        webContents.stop();
      } catch {
        // Ignore teardown races while reporting the original timeout.
      }
      reject(new Error(`Timed out loading ${url} after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
  });

  try {
    await Promise.race([loadPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      loadPromise.catch(() => {});
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Tiles up to N live BrowserViews (one per pane) at rectangles computed by the
 * main process. This replaces the old single-active-view model so multiple
 * sessions can render and run in parallel (the 2x2 grid).
 */
export class ViewHost {
  constructor({ getMainWindow, getPreloadPath, openExternalUrl, showError, onPaneUpdate, onPaneFocus }) {
    this.getMainWindow = getMainWindow;
    this.getPreloadPath = getPreloadPath;
    this.openExternalUrl = openExternalUrl;
    this.showError = showError;
    this.onPaneUpdate = onPaneUpdate || (() => {});
    this.onPaneFocus = onPaneFocus || (() => {});
    // paneId -> { view, loadedUrl, title, injected }
    this.panes = new Map();
    this.activePaneId = null;
    this.sidebarHideCss = null;
    this.overrideCss = null;
  }

  setSidebarHideCss(css) {
    this.sidebarHideCss = css || null;
  }

  setOverrideCss(css) {
    this.overrideCss = css || null;
  }

  // Hide the web app's sidebar only inside an actual session (`/session/*`) so
  // chats are full-bleed, but keep it on `/` where you pick a project / start
  // a new session. Toggles as the SPA navigates.
  applySidebarVisibility(entry) {
    if (!this.sidebarHideCss) return;
    const wc = entry.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    let pathname = '';
    try { pathname = new URL(wc.getURL()).pathname; } catch { pathname = ''; }
    const shouldHide = /\/session\//.test(pathname);
    if (shouldHide && !entry.cssKey) {
      wc.insertCSS(this.sidebarHideCss).then((key) => { entry.cssKey = key; }).catch(() => {});
    } else if (!shouldHide && entry.cssKey) {
      const key = entry.cssKey;
      entry.cssKey = null;
      wc.removeInsertedCSS(key).catch(() => {});
    }
  }

  configureChildWebContents(webContents) {
    webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternalUrl(url).catch((error) => this.showError('Could not open external link', error));
      return { action: 'deny' };
    });
  }

  ensurePane(paneId) {
    let entry = this.panes.get(paneId);
    if (entry) return entry;

    const view = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });
    this.configureChildWebContents(view.webContents);

    entry = { view, loadedUrl: null, title: '', cssKey: null };
    this.panes.set(paneId, entry);

    const { webContents } = view;
    webContents.on('page-title-updated', (_event, title) => {
      entry.title = title;
      this.onPaneUpdate(paneId, { title, url: webContents.getURL() });
    });
    webContents.on('did-navigate', (_event, url) => {
      this.applySidebarVisibility(entry);
      this.onPaneUpdate(paneId, { title: entry.title, url });
    });
    webContents.on('did-navigate-in-page', (_event, url) => {
      this.applySidebarVisibility(entry);
      this.onPaneUpdate(paneId, { title: entry.title, url });
    });
    webContents.on('dom-ready', () => {
      if (this.overrideCss) webContents.insertCSS(this.overrideCss).catch(() => {});
      this.applySidebarVisibility(entry);
    });
    // Click-to-focus: the pane the user clicks into becomes active (drives the
    // accent frame + titlebar controls) — replaces the removed pane header.
    webContents.on('focus', () => this.onPaneFocus(paneId));

    return entry;
  }

  /**
   * Reconcile the attached BrowserViews with the requested panes.
   * @param {Array<{id:string,url:string,bounds:{x,y,width,height},active:boolean}>} panes
   */
  async syncPanes(panes) {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const wanted = new Set(panes.map((pane) => pane.id));
    for (const paneId of [...this.panes.keys()]) {
      if (!wanted.has(paneId)) this.destroyPane(paneId);
    }

    // Detach everything, then attach in requested order (stable z-order).
    try {
      for (const view of mainWindow.getBrowserViews()) {
        mainWindow.removeBrowserView(view);
      }
    } catch {
      // Views may be mid-teardown; ignore.
    }

    for (const pane of panes) {
      const entry = this.ensurePane(pane.id);
      try {
        mainWindow.addBrowserView(entry.view);
      } catch {
        continue;
      }
      entry.view.setBounds(pane.bounds);
      entry.view.setAutoResize({ width: false, height: false });

      if (isHttpUrl(pane.url) && entry.loadedUrl !== pane.url) {
        entry.loadedUrl = pane.url;
        loadUrlWithTimeout(entry.view.webContents, pane.url).catch((error) => {
          if (isExpectedNavigationAbort(error)) return;
          this.onPaneUpdate(pane.id, { error: error?.message || String(error) });
        });
      }
    }

    const active = panes.find((pane) => pane.active) || panes[0];
    this.activePaneId = active?.id || null;
    if (active) {
      const entry = this.panes.get(active.id);
      if (entry && !entry.view.webContents.isDestroyed()) {
        entry.view.webContents.focus();
      }
    }
  }

  detachAll() {
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      for (const view of mainWindow.getBrowserViews()) {
        mainWindow.removeBrowserView(view);
      }
    } catch {
      // ignore teardown races
    }
  }

  getPaneState(paneId) {
    const entry = this.panes.get(paneId);
    if (!entry || entry.view.webContents.isDestroyed()) return null;
    return {
      id: paneId,
      title: entry.title || '',
      url: entry.view.webContents.getURL(),
    };
  }

  reloadPane(paneId) {
    const entry = this.panes.get(paneId);
    if (!entry || entry.view.webContents.isDestroyed()) return false;
    entry.view.webContents.reloadIgnoringCache();
    return true;
  }

  reloadActivePane() {
    return this.activePaneId ? this.reloadPane(this.activePaneId) : false;
  }

  async navigatePane(paneId, url) {
    const entry = this.panes.get(paneId);
    if (!entry || entry.view.webContents.isDestroyed()) return false;
    if (!isHttpUrl(url)) return false;
    entry.loadedUrl = url;
    await loadUrlWithTimeout(entry.view.webContents, url);
    return true;
  }

  openPaneDevTools(paneId = this.activePaneId) {
    const entry = paneId ? this.panes.get(paneId) : null;
    if (!entry || entry.view.webContents.isDestroyed()) return false;
    entry.view.webContents.openDevTools({ mode: 'detach' });
    return true;
  }

  async runInPane(paneId, code) {
    const entry = this.panes.get(paneId);
    if (!entry || entry.view.webContents.isDestroyed()) return null;
    try {
      return await entry.view.webContents.executeJavaScript(code, true);
    } catch {
      return null;
    }
  }

  async readLocalStorageValueForOrigin(originUrl, key) {
    let targetOrigin;
    try {
      targetOrigin = new URL(originUrl).origin;
    } catch {
      return null;
    }

    for (const entry of this.panes.values()) {
      const { webContents } = entry.view;
      if (!webContents || webContents.isDestroyed()) continue;
      let viewOrigin;
      try {
        viewOrigin = new URL(webContents.getURL()).origin;
      } catch {
        continue;
      }
      if (viewOrigin !== targetOrigin) continue;
      try {
        const value = await webContents.executeJavaScript(
          `window.localStorage.getItem(${JSON.stringify(key)})`,
          true,
        );
        return typeof value === 'string' && value ? value : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  destroyPane(paneId) {
    const entry = this.panes.get(paneId);
    if (!entry) return;
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        if (mainWindow.getBrowserViews().includes(entry.view)) {
          mainWindow.removeBrowserView(entry.view);
        }
      } catch {
        // ignore teardown races
      }
    }
    try {
      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.destroy();
      }
    } catch {
      // already destroyed by parent
    }
    this.panes.delete(paneId);
    if (this.activePaneId === paneId) this.activePaneId = null;
  }

  clear() {
    this.panes.clear();
    this.activePaneId = null;
  }
}
