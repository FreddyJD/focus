'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between renderer and main. Renderers have no Node access;
 * every privileged action goes through a named channel validated in main.
 *
 * Exposed as `focusApi` rather than `focus` so it does not shadow the
 * built-in window.focus() method.
 */
const api = {
  // --- state ---
  getState: () => ipcRenderer.invoke('focus:getState'),
  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('focus:state', handler);
    return () => ipcRenderer.removeListener('focus:state', handler);
  },
  onFocusAddressBar: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('focus:focusAddressBar', handler);
    return () => ipcRenderer.removeListener('focus:focusAddressBar', handler);
  },

  // --- session control ---
  startSession: (opts) => ipcRenderer.invoke('focus:start', opts),
  pause: () => ipcRenderer.invoke('focus:pause'),
  resume: () => ipcRenderer.invoke('focus:resume'),
  togglePause: () => ipcRenderer.invoke('focus:togglePause'),
  complete: () => ipcRenderer.invoke('focus:complete'),
  quitSession: () => ipcRenderer.invoke('focus:quitSession'),
  extend: (ms) => ipcRenderer.invoke('focus:extend', ms),
  newSession: () => ipcRenderer.invoke('focus:newSession'),
  installUpdate: () => ipcRenderer.invoke('focus:installUpdate'),

  // --- activity ---
  getActivity: () => ipcRenderer.invoke('focus:getActivity'),
  openActivity: () => ipcRenderer.invoke('focus:openActivity'),
  closeActivity: () => ipcRenderer.invoke('focus:closeActivity'),

  // --- AI chat ---
  ai: {
    getConfig: () => ipcRenderer.invoke('ai:getConfig'),
    setKey: (key) => ipcRenderer.invoke('ai:setKey', key),
    clearKey: () => ipcRenderer.invoke('ai:clearKey'),
    setModel: (m) => ipcRenderer.invoke('ai:setModel', m),
    setBaseUrl: (u) => ipcRenderer.invoke('ai:setBaseUrl', u),
    listModels: () => ipcRenderer.invoke('ai:listModels'),

    send: (payload) => ipcRenderer.invoke('ai:send', payload),
    cancel: () => ipcRenderer.invoke('ai:cancel'),
    approve: (id, approved) => ipcRenderer.invoke('ai:approve', { id, approved }),
    toggle: (open) => ipcRenderer.invoke('ai:toggle', open),

    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on('ai:event', h);
      return () => ipcRenderer.removeListener('ai:event', h);
    },
    onApprove: (cb) => {
      const h = (_e, call) => cb(call);
      ipcRenderer.on('ai:approve', h);
      return () => ipcRenderer.removeListener('ai:approve', h);
    },

    listSkills: () => ipcRenderer.invoke('ai:listSkills'),
    installSkillUrl: (url) => ipcRenderer.invoke('ai:installSkillUrl', url),
    installSkillText: (name, markdown) =>
      ipcRenderer.invoke('ai:installSkillText', { name, markdown }),
    removeSkill: (id) => ipcRenderer.invoke('ai:removeSkill', id),

    listMcp: () => ipcRenderer.invoke('ai:listMcp'),
    addMcp: (spec) => ipcRenderer.invoke('ai:addMcp', spec),
    removeMcp: (id) => ipcRenderer.invoke('ai:removeMcp', id),
  },

  // --- config ---
  setConfig: (patch) => ipcRenderer.invoke('focus:setConfig', patch),  addSite: (value) => ipcRenderer.invoke('focus:addSite', value),
  removeSite: (value) => ipcRenderer.invoke('focus:removeSite', value),
  addApp: () => ipcRenderer.invoke('focus:addApp'),
  removeApp: (value) => ipcRenderer.invoke('focus:removeApp', value),

  // --- browsing ---
  navigate: (url) => ipcRenderer.invoke('focus:navigate', url),
  newTab: (url) => ipcRenderer.invoke('focus:newTab', url),
  closeTab: (id) => ipcRenderer.invoke('focus:closeTab', id),
  selectTab: (id) => ipcRenderer.invoke('focus:selectTab', id),
  goBack: () => ipcRenderer.invoke('focus:goBack'),
  goForward: () => ipcRenderer.invoke('focus:goForward'),
  reload: () => ipcRenderer.invoke('focus:reload'),
  stop: () => ipcRenderer.invoke('focus:stop'),

  // --- windows / overlay ---
  openSettings: () => ipcRenderer.invoke('focus:openSettings'),
  closeOverlay: () => ipcRenderer.invoke('focus:closeOverlay'),
  minimizeWindow: () => ipcRenderer.invoke('focus:minimize'),
  quit: () => ipcRenderer.invoke('focus:quit'),

  // --- blocked page ---
  getBlockInfo: () => ipcRenderer.invoke('focus:getBlockInfo'),
  allowBlockedSite: (host) => ipcRenderer.invoke('focus:allowBlockedSite', host),
};

contextBridge.exposeInMainWorld('focusApi', api);
