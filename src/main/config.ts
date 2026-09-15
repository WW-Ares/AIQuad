import fs from 'node:fs'
import path from 'node:path'
import type { AiService, AppConfig } from './types'
import { normalizeAccelerator } from './accelerator'

const CONFIG_VERSION = 5

/**
 * 早期版本给"分格切换"预设了 Ctrl+Alt+1/2/4，实际会和其它软件抢键，
 * 而顶栏本来就有 1/2/4 的按钮，所以从 v0.4.8 起这三个默认为空（= 不注册）。
 * 迁移时只清掉**没被改过**的那几个，用户自己设的组合照旧保留。
 */
const LEGACY_LAYOUT_SHORTCUTS: Record<string, string> = {
  layout1: 'Ctrl+Alt+1',
  layout2: 'Ctrl+Alt+2',
  layout4: 'Ctrl+Alt+4',
}

/**
 * 内置 AI 清单。按「国外（us）在前、国内（cn）在后」分组。
 * logo 对应 src/renderer/assets/ 下的文件名。
 */
const DEFAULT_AI: AiService[] = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/', category: 'us', logo: 'chatgpt.png', proxyMode: 'global', builtin: true },
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app', category: 'us', logo: 'gemini.png', proxyMode: 'global', builtin: true },
  { id: 'grok', name: 'Grok', url: 'https://grok.com/', category: 'us', logo: 'grok.png', proxyMode: 'global', builtin: true },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new', category: 'us', logo: '', proxyMode: 'global', builtin: true },
  { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/', category: 'us', logo: '', proxyMode: 'global', builtin: true },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', category: 'cn', logo: 'deepseek.png', proxyMode: 'direct', builtin: true },
  { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/', category: 'cn', logo: 'kimi.png', proxyMode: 'direct', builtin: true },
  { id: 'qwen', name: '通义千问', url: 'https://chat.qwen.ai/', category: 'cn', logo: 'qwen.png', proxyMode: 'direct', builtin: true },
  { id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/', category: 'cn', logo: 'doubao.png', proxyMode: 'direct', builtin: true },
  { id: 'yuanbao', name: '元宝', url: 'https://yuanbao.tencent.com/chat/', category: 'cn', logo: 'yuanbao.png', proxyMode: 'direct', builtin: true },
  { id: 'glm', name: '智谱清言', url: 'https://chatglm.cn/', category: 'cn', logo: '', proxyMode: 'direct', builtin: true },
]

export function defaultConfig(): AppConfig {
  return {
    version: CONFIG_VERSION,
    panes: [
      { id: 'p1', aiId: 'deepseek' },
      { id: 'p2', aiId: 'chatgpt' },
      { id: 'p3', aiId: 'gemini' },
      { id: 'p4', aiId: 'doubao' },
    ],
    layout: '1',
    aiList: DEFAULT_AI.map((a) => ({ ...a })),
    proxy: {
      mode: 'system',
      type: 'http',
      host: '',
      port: '',
      bypassList: '',
    },
    shortcuts: {
      toggleFloat: 'Alt+Space',
      // 分格切换默认不绑键：顶栏有按钮，绑了反而容易和别的软件冲突
      layout1: '',
      layout2: '',
      layout4: '',
    },
    position: 'right',
    windowWidthRatio: 0.3,
    windowMode: 'standard',
    sharedSession: true,
    alwaysOnTop: true,
    hibernateBackground: false,
    // 用不到的分格先藏着，闲置 10 分钟就真的关掉（页面才是内存大头）
    paneCleanup: true,
    paneCleanupDelayMin: 10,
    autoStart: false,
    browserPreference: 'auto',
    customBrowserPath: '',
    // 默认自动：缓存超过 500MB 就在下次启动时清一遍。
    // 只清 Cache / Code Cache 这类可再生的东西，不动登录态。
    cacheCleanup: 'auto',
  }
}

export class ConfigStore {
  private file: string
  private data: AppConfig
  /** 磁盘上那份配置的版本号，用来判断要不要跑迁移（见 normalize） */
  private loadedVersion = CONFIG_VERSION

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'config.json')
    this.data = defaultConfig()
    this.load()
  }

  get path() {
    return this.file
  }

  private load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        this.data = this.merge(this.data, raw)
        this.loadedVersion = Number((this.data as any)?.version) || 0
      }
    }
    catch (e) {
      console.warn('[config] load failed, using defaults', e)
    }
    this.normalize()
    // 迁移过就把新版本号写回去，免得每次启动都重跑一遍迁移。
    // version 必须显式更新：`save()` 落盘的就是 data 本身，不设的话磁盘上还写着旧版本号。
    if (this.loadedVersion !== CONFIG_VERSION) {
      this.data.version = CONFIG_VERSION
      this.save()
    }
  }

  /**
   * 兼容旧版本配置：补齐分组、图标等新增字段，修正非法的布局值。
   * 否则旧配置里的 AI 项会因缺少 category 而无法在切换器中显示。
   */
  normalize() {
    const builtin = new Map(DEFAULT_AI.map((a) => [a.id, a]))
    const seen = new Set<string>()
    this.data.aiList = this.data.aiList
      .map((a: any) => {
        const base = builtin.get(a.id)
        const merged = {
          ...(base || {}),
          ...a,
          category: a.category || base?.category || 'cn',
          logo: a.logo === undefined ? (base?.logo ?? '') : a.logo,
        }
        return merged
      })
      // 内置项去重（旧配置可能存了重复项）
      .filter((a: any) => {
        if (seen.has(a.id)) return false
        seen.add(a.id)
        return true
      })

    // 布局只保留 1 / 2 / 4；旧版本若有 '3' 迁移到 '2'（上下两格）
    const layout = String(this.data.layout)
    if (layout === '3') this.data.layout = '2'
    else if (!['1', '2', '4'].includes(layout)) this.data.layout = '1'
    // 清理旧版本遗留的第三格快捷键
    delete (this.data.shortcuts as any).layout3
    // v0.4.8 起分格切换不再默认绑键。只还原"从没改过"的那几个，
    // 用户自己抓过的组合（值不等于旧默认值）保持原样。
    if (this.loadedVersion < 4) {
      for (const [k, legacy] of Object.entries(LEGACY_LAYOUT_SHORTCUTS)) {
        if ((this.data.shortcuts as any)[k] === legacy) (this.data.shortcuts as any)[k] = ''
      }
    }
    // 快捷键统一成规范写法（Ctrl+Alt+K / Alt+Space …），手改过 config.json 也能正常工作。
    // 不合法的一律**原样保留**：让设置页能显示"这个组合有问题"，而不是悄悄换成默认值。
    for (const k of ['toggleFloat', 'layout1', 'layout2', 'layout4']) {
      const cur = (this.data.shortcuts as any)[k]
      if (typeof cur !== 'string') continue
      const norm = normalizeAccelerator(cur)
      if (norm) (this.data.shortcuts as any)[k] = norm
    }
    if (this.data.position !== 'left' && this.data.position !== 'right') this.data.position = 'right'
    if (this.data.windowMode !== 'app' && this.data.windowMode !== 'standard') this.data.windowMode = 'standard'
    // 登录态共享默认开启：旧配置没有这个字段时按开启处理（这是 v0.4 的主行为）
    this.data.sharedSession = this.data.sharedSession !== false

    // 用户可以删掉全部 AI（早期版本允许），那样每个分格都取不到 AI、整块面板变空。
    // 兜底恢复内置清单，宁可"删不掉最后一个"也不能让面板没法用。
    if (!Array.isArray(this.data.aiList) || this.data.aiList.length === 0) {
      this.data.aiList = DEFAULT_AI.map((a) => ({ ...a }))
    }
    if (!['off', 'auto', 'exit'].includes(this.data.cacheCleanup)) this.data.cacheCleanup = 'auto'

    this.data.paneCleanup = this.data.paneCleanup !== false
    const delay = Number(this.data.paneCleanupDelayMin)
    // 太小等于"一切就关"（来回切布局要重开浏览器），太大就失去意义
    this.data.paneCleanupDelayMin = Number.isFinite(delay) ? Math.min(120, Math.max(1, Math.round(delay))) : 10

    const ratio = Number(this.data.windowWidthRatio)
    if (!Number.isFinite(ratio) || ratio < 0.15 || ratio > 0.9) this.data.windowWidthRatio = 0.3

    // 保证 4 个分格都存在，且绑定的 AI 可用
    const ids = ['p1', 'p2', 'p3', 'p4']
    const fallbackPanes = defaultConfig().panes
    const panes = ids.map((id, i) => {
      const found = this.data.panes.find((p: any) => p.id === id)
      let aiId: string | undefined
      if (found?.aiId && this.data.aiList.some((a) => a.id === found.aiId)) {
        aiId = found.aiId
      }
      else {
        // 优先回退到默认清单里的同位置 AI，其次按顺序取
        const preferred = fallbackPanes[i]?.aiId
        aiId = preferred && this.data.aiList.some((a) => a.id === preferred)
          ? preferred
          : (this.data.aiList[i]?.id ?? this.data.aiList[0]?.id)
      }
      return { id, aiId: aiId as string }
    })
    this.data.panes = panes
  }

  private merge(base: any, patch: any): any {
    if (Array.isArray(base)) return Array.isArray(patch) ? patch : base
    if (base && typeof base === 'object') {
      const out: any = { ...base }
      for (const key of Object.keys(base)) {
        if (patch && key in patch) out[key] = this.merge(base[key], patch[key])
      }
      // 保留 patch 中模板未声明的字段（例如自动探测写入的 proxy.systemServer）
      if (patch && typeof patch === 'object') {
        for (const key of Object.keys(patch)) {
          if (!(key in out)) out[key] = patch[key]
        }
      }
      return out
    }
    return patch === undefined ? base : patch
  }

  get(): AppConfig {
    return this.data
  }

  /**
   * 顶层浅合并后立刻过一遍 normalize。
   *
   * 不校验的话，任何越界值（比例填了 5、布局写成 '3'）都会直接落到磁盘和正在跑的
   * 界面上，要等下次启动才被纠正——那之前面板就是坏的。取舍和 load() 一致：
   * 宁可悄悄修正，也不要带病运行。
   */
  update(patch: Partial<AppConfig>): AppConfig {
    this.data = { ...this.data, ...patch, version: CONFIG_VERSION }
    this.normalize()
    this.save()
    return this.data
  }

  save() {
    try {
      const dir = path.dirname(this.file)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    }
    catch (e) {
      console.error('[config] save failed', e)
    }
  }
}
