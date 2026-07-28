const { contextBridge, ipcRenderer } = require('electron');

function onDesktopStateUpdated(callback) {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('cloudcli-desktop:state-updated', listener);
  return () => ipcRenderer.removeListener('cloudcli-desktop:state-updated', listener);
}

// Only the connect/chrome layer (file: URL) gets the privileged bridge. Remote
// server pages loaded in panes get no desktop API.
if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('cloudcliDesktop', {
    getState: () => ipcRenderer.invoke('cloudcli-desktop:get-state'),
    connectServer: (url, layout) => ipcRenderer.invoke('cloudcli-desktop:connect-server', url, layout),
    connectRecent: (url) => ipcRenderer.invoke('cloudcli-desktop:connect-recent', url),
    showConnectScreen: () => ipcRenderer.invoke('cloudcli-desktop:show-connect-screen'),
    forgetServer: (url) => ipcRenderer.invoke('cloudcli-desktop:forget-server', url),
    setLayout: (n) => ipcRenderer.invoke('cloudcli-desktop:set-layout', n),
    setPaneUrl: (paneId, url) => ipcRenderer.invoke('cloudcli-desktop:set-pane-url', paneId, url),
    focusPane: (paneId) => ipcRenderer.invoke('cloudcli-desktop:focus-pane', paneId),
    expandPane: (paneId) => ipcRenderer.invoke('cloudcli-desktop:expand-pane', paneId),
    clearPane: (paneId) => ipcRenderer.invoke('cloudcli-desktop:clear-pane', paneId),
    reloadPane: (paneId) => ipcRenderer.invoke('cloudcli-desktop:reload-pane', paneId),
    listProjects: () => ipcRenderer.invoke('cloudcli-desktop:list-projects'),
    listSessions: (projectId) => ipcRenderer.invoke('cloudcli-desktop:list-sessions', projectId),
    openSessionInPane: (paneId, sessionId) => ipcRenderer.invoke('cloudcli-desktop:open-session-in-pane', paneId, sessionId),
    newSessionInPane: (paneId, projectId) => ipcRenderer.invoke('cloudcli-desktop:new-session-in-pane', paneId, projectId),
    setOverlay: (active) => ipcRenderer.invoke('cloudcli-desktop:set-overlay', active),
    readAuthToken: () => ipcRenderer.invoke('cloudcli-desktop:read-auth-token'),
    copyDiagnostics: () => ipcRenderer.invoke('cloudcli-desktop:copy-diagnostics'),
    openExternal: (url) => ipcRenderer.invoke('cloudcli-desktop:open-external', url),
    onStateUpdated: onDesktopStateUpdated,
  });
}
