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
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  panelToggle: () => ipcRenderer.invoke('panel-toggle'),
  panelHide: () => ipcRenderer.invoke('panel-hide'),
  panelDragStart: () => ipcRenderer.invoke('panel-drag-start'),
  panelDragMove: (dx: number, dy: number) => ipcRenderer.invoke('panel-drag-move', dx, dy),
  panelDragEnd: () => ipcRenderer.invoke('panel-drag-end'),
  /**
   * 面板按需鼠标穿透（单向高频消息，不需要回执）。
   * 渲染层每帧判断指针是否压在网页区上，只在与上次不同时打过来。
   */
  mousePassthrough: (through: boolean) => ipcRenderer.send('mouse-passthrough', through),
  syncInstances: () => ipcRenderer.invoke('sync-instances'),
  testProxy: (proxy: any, url: string) => ipcRenderer.invoke('test-proxy', proxy, url),
  openPath: (p: string) => ipcRenderer.invoke('open-path', p),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  /** 扫描浏览器档案：总体积与可清理缓存体积 */
  getCacheStats: () => ipcRenderer.invoke('get-cache-stats'),
  /** 清理上述缓存（保留 Cookies / Local Storage，登录态不受影响） */
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  setAlwaysOnTop: (v: boolean) => ipcRenderer.invoke('set-always-on-top', v),
  on: (channel: string, fn: (...args: any[]) => void) => {
    const listener = (_e: any, ...args: any[]) => fn(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
}

contextBridge.exposeInMainWorld('aiquad', api)

export type AiquadApi = typeof api
