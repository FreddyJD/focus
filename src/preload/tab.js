'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload for TAB views, which load untrusted remote web pages.
 *
 * Security: the API is exposed only to the app's own local pages
 * (file:// .../blocked.html). Without this gate, every website you visit
 * could call pause(), complete(), or allowBlockedSite() and disable the
 * blocker from inside a page — which would make the whole app pointless.
 *
 * A remote page cannot fake its own location: it is set by the browser
 * before the preload runs, and changing it requires a real navigation.
 */
function isTrustedInternalPage() {
  try {
    if (window.location.protocol !== 'file:') return false;
    const p = decodeURIComponent(window.location.pathname).toLowerCase();
    return p.endsWith('/blocked.html');
  } catch {
    return false;
  }
}

if (isTrustedInternalPage()) {
  contextBridge.exposeInMainWorld('focusApi', {
    getState: () => ipcRenderer.invoke('focus:getState'),
    onState: (cb) => {
      const handler = (_e, state) => cb(state);
      ipcRenderer.on('focus:state', handler);
      return () => ipcRenderer.removeListener('focus:state', handler);
    },
    getBlockInfo: () => ipcRenderer.invoke('focus:getBlockInfo'),
    allowBlockedSite: (host) => ipcRenderer.invoke('focus:allowBlockedSite', host),
    navigate: (url) => ipcRenderer.invoke('focus:navigate', url),
    reload: () => ipcRenderer.invoke('focus:reload'),
    pause: () => ipcRenderer.invoke('focus:pause'),
  });
}
