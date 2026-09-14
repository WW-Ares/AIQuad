import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  saveConfig: (patch: any) => ipcRenderer.invoke('save-config', patch),
  probeShortcut: (acc: string) => ipcRenderer.invoke('probe-shortcut', acc),
  shortcutIssues: () => ipcRenderer.invoke('get-shortcut-issues'),
  setPaneAi: (paneId: string, aiId: string) => ipcRenderer.invoke('set-pane-ai', paneId, aiId),
  setLayout: (layout: string) => ipcRenderer.invoke('set-layout', layout),
  paneRects: (rects: any[]) => ipcRenderer.invoke('pane-rects', rects),
  paneOcclude: (paneId: string, on: boolean, hole?: any) => ipcRenderer.invoke('pane-occlude', paneId, on, hole),
  instanceAction: (paneId: string, action: string) => ipcRenderer.invoke('instance-action', paneId, action),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  panelToggle: () => ipcRenderer.invoke('panel-toggle'),
  panelHide: () => ipcRenderer.invoke('panel-hide'),
  syncInstances: () => ipcRenderer.invoke('sync-instances'),
  testProxy: (proxy: any, url: string) => ipcRenderer.invoke('test-proxy', proxy, url),
  openPath: (p: string) => ipcRenderer.invoke('open-path', p),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  setAlwaysOnTop: (v: boolean) => ipcRenderer.invoke('set-always-on-top', v),
  on: (channel: string, fn: (...args: any[]) => void) => {
    const listener = (_e: any, ...args: any[]) => fn(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
}

contextBridge.exposeInMainWorld('aiquad', api)

export type AiquadApi = typeof api
