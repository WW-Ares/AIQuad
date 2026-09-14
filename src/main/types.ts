export type ProxyMode = 'system' | 'none' | 'custom'

export interface ProxyConfig {
  mode: ProxyMode
  type: 'http' | 'https' | 'socks5'
  host: string
  port: number | string
  bypassList: string
  /** 系统代理（启动后自动探测，只读展示用） */
  systemServer?: string
  systemType?: 'http' | 'https' | 'socks5'
}

/** AI 分组：us = 国外（一般需要代理），cn = 国内（一般直连） */
export type AiCategory = 'us' | 'cn'

export interface AiService {
  id: string
  name: string
  url: string
  category: AiCategory
  /** assets 目录下的图标文件名；留空则用名称首字母生成占位图标 */
  logo?: string
  /** global = 跟随全局代理；direct = 直连；custom = 单独代理 */
  proxyMode: 'global' | 'direct' | 'custom'
  proxy?: ProxyConfig
  builtin?: boolean
}

/** 1 / 2 / 4 三种分格；竖长面板按行分割，4 为 2×2 */
export type LayoutId = '1' | '2' | '4'

/** 面板贴屏幕的哪一侧 */
export type PanelPosition = 'left' | 'right'

/**
 * 浏览器窗口形态：
 * - standard：标准浏览器窗口（display-mode = browser，与手动打开浏览器一致），
 *   工具栏由 Win32 上移裁剪隐藏。**登录兼容性最好，默认使用**。
 * - app：`--app` 应用窗口，无工具栏但 display-mode = standalone，
 *   部分站点（Google 登录）会判定为"应用内嵌浏览器"而拒绝。
 */
export type BrowserWindowMode = 'standard' | 'app'

export interface PaneState {
  id: string
  aiId: string
}

export interface ShortcutConfig {
  /** 呼出 / 收起面板 */
  toggleFloat: string
  layout1: string
  layout2: string
  layout4: string
}

export interface AppConfig {
  version: number
  panes: PaneState[]
  layout: LayoutId
  aiList: AiService[]
  proxy: ProxyConfig
  shortcuts: ShortcutConfig
  /** 面板停靠位置 */
  position: PanelPosition
  /** 面板宽度占屏幕宽度比例（0.2 / 0.3 / 0.4 / 0.5） */
  windowWidthRatio: number
  /** 分格内浏览器窗口形态，默认 standard（登录兼容性优先） */
  windowMode: BrowserWindowMode
  /**
   * 登录态共享：所有分格共用同一个浏览器档案（同一个浏览器进程的多个窗口）。
   * 打开后，在任意分格登录的账号其它分格直接可用（Cookie / localStorage 共享）。
   * 代价：代理是进程级设置，此时按全局代理走，不再支持按 AI 单独设代理。
   * 关闭则每个分格一个独立档案（各自独立登录，可按 AI 单独设代理）。
   */
  sharedSession: boolean
  alwaysOnTop: boolean
  hibernateBackground: boolean
  autoStart: boolean
  browserPreference: 'chrome' | 'edge' | 'auto'
  customBrowserPath: string
}

export interface PaneRect {
  paneId: string
  x: number
  y: number
  width: number
  height: number
}
