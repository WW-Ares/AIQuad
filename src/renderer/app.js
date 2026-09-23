/* AIQuad 面板渲染层：顶栏图标按钮 + 分格网格 + 每格底部悬浮 AI 选择器 */
const api = window.aiquad

const LAYOUT_COUNT = { '1': 1, '2': 2, '4': 4 }

/**
 * 每格底部为 AI 切换器预留的条带高度（CSS px）。现在恒为 0：
 * 切换器不再占条带，而是悬浮在网页之上（"灵动岛"式），
 * 由主进程把这一小块从原生浏览器窗口的可视区域里挖掉，页面因此能铺到底。
 *
 * 唯一来源仍是 styles.css 的 --pane-footer，避免两边各写一个数字后悄悄失配。
 * 注意允许取 0 —— 早先写成 `v > 0 ? v : 28`，一旦有人把它调成 0
 * 就会静默退回 28，把"取消预留"这件事悄悄吃掉。
 */
const PANE_FOOTER = (() => {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pane-footer'))
  return Number.isFinite(v) && v >= 0 ? v : 28
})()

const state = {
  config: null,
  paneIds: [],
  statuses: {},
  /** 当前展开下拉的格子 */
  menuPane: null,
  /** 已就位的格子（浏览器窗口已嵌入，可遮挡原生窗口） */
  readyPanes: new Set(),
}

/* ---------------- 面板按需鼠标穿透 ---------------- */

/**
 * 分格区域必须"点得穿"：面板整窗忽略鼠标，点击直接落到那一格下面的浏览器窗口上；
 * 顶栏、悬浮 AI 切换器、展开的下拉菜单是面板自己的 UI，必须把鼠标收回来。
 *
 * 判断依据是 elementFromPoint 命中的元素在哪一层：落在**已就位**的 `.pane` 里就是网页区，
 * 穿透；落在 `.ai-selector` / `.ai-menu`（它们同样在 pane 内，但浮在网页之上）或者 pane 之外
 * 的任何地方（顶栏、格间缝隙、未就位格子里的占位按钮）就不穿透。
 *
 * 只在状态翻转时发 IPC：鼠标每动一像素都过一次主进程的话，划词、拖日历这类操作会发涩。
 *
 * 面板显示的那一瞬间由主进程按指针位置先定一次，这里接上之后逐帧修正。
 */
let passthrough = null
/** 最近一次指针位置：下拉开合之后要拿它重算一次穿透（收不回来就会卡在不穿透上） */
let pointerAt = { x: -1, y: -1 }

function syncPassthrough(x, y) {
  if (x != null) pointerAt = { x, y }
  /**
   * 下拉展开期间**整块面板都必须收回鼠标**。
   *
   * 平时分格是穿透的，点在网页上的单击会直接落到下面的浏览器窗口，渲染层根本
   * 收不到 click ——结果"点列表外面收起列表"这件最自然的事做不到，只能回过头去
   * 菜单开着的时候先不穿透，点在面板范围内的任何地方（包括其它分格的网页上）
   * 都由面板接住，落到下面那个 document 级监听里把菜单收起来。
   */
  if (state.menuPane) {
    setPassthrough(false)
    return
  }
  const hit = document.elementFromPoint(pointerAt.x, pointerAt.y)
  const pane = hit && hit.closest('.pane')
  const widget = !!(hit && hit.closest('.ai-selector, .ai-menu'))
  const through = !!(pane && pane.classList.contains('ready') && !widget)
  setPassthrough(through)
}

/**
 * 只在状态**翻转**时才发 IPC：鼠标每动一像素都过一次主进程的话，划词、拖日历
 * 这类操作会发涩（见文件头）。
 *
 * 呼出面板那一下**不在这里**对齐：渲染层手上的点位可能是陈旧的，硬发一次反而会
 * 覆盖掉主进程刚算对的值（见 panel-shown 的说明）。`passthrough` 被置 null 之后，
 * 下一次真的翻转必定会上报。
 */
function setPassthrough(through) {
  if (through === passthrough) return
  passthrough = through
  api.mousePassthrough(through)
}

window.addEventListener('mousemove', (e) => syncPassthrough(e.clientX, e.clientY), { passive: true })

/* ---------------- 工具 ---------------- */

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function aiById(id) {
  return state.config?.aiList.find((a) => a.id === id) || null
}

function initial(name) {
  return (name || '?').trim().charAt(0)
}

function buildLogo(ai, size) {
  const img = document.createElement('img')
  img.className = 'ai-logo'
  if (ai && ai.logo) {
    img.src = `assets/${ai.logo}`
    img.alt = ai.name
  }
  else {
    const span = el('span', 'ai-logo fallback', initial(ai ? ai.name : '?'))
    if (size) { span.style.width = `${size}px`; span.style.height = `${size}px` }
    return span
  }
  if (size) { img.style.width = `${size}px`; img.style.height = `${size}px` }
  return img
}

function visiblePaneIds() {
  const cfg = state.config
  const n = LAYOUT_COUNT[cfg.layout] || 1
  return cfg.panes.slice(0, n).map((p) => p.id)
}

/* ---------------- 单个分格 ---------------- */

function buildPane(paneId) {
  const box = el('div', 'pane')
  box.dataset.paneId = paneId

  const placeholder = el('div', 'pane-placeholder')
  placeholder.dataset.role = 'placeholder'
  box.appendChild(placeholder)

  const loadbar = el('div', 'loadbar')
  loadbar.dataset.role = 'loadbar'
  box.appendChild(loadbar)

  const scrim = el('div', 'pane-scrim')
  box.appendChild(scrim)

  // 底部居中 AI 选择器
  const selector = el('div', 'ai-selector')
  const btn = el('button', 'ai-select')
  btn.dataset.role = 'aitrigger'
  const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  caret.setAttribute('class', 'caret')
  caret.setAttribute('viewBox', '0 0 24 24')
  caret.setAttribute('fill', 'none')
  caret.setAttribute('stroke', 'currentColor')
  caret.setAttribute('stroke-width', '2.4')
  caret.setAttribute('stroke-linecap', 'round')
  const caretPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  caretPath.setAttribute('d', 'M6 9.5 12 15.5 18 9.5')
  caret.appendChild(caretPath)
  selector.appendChild(btn)
  // caret 在 buildSelector 中放到末尾（label 之后）
  box.appendChild(selector)

  const menu = el('div', 'ai-menu')
  menu.dataset.role = 'aimenu'
  box.appendChild(menu)

  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleMenu(state.menuPane === paneId ? null : paneId)
  })
  scrim.addEventListener('click', () => toggleMenu(null))

  return box
}

function updatePane(paneId) {
  const box = document.querySelector(`.pane[data-pane-id="${paneId}"]`)
  if (!box || !state.config) return
  const pane = state.config.panes.find((p) => p.id === paneId)
  const ai = aiById(pane?.aiId)
  const status = state.statuses[paneId]?.status || 'idle'
  const ready = status === 'ready'
  state.readyPanes[ready ? 'add' : 'delete'](paneId)
  /**
   * ready = 浏览器窗口已经铺满这一格。
   * 面板窗口是透明的，这一格必须跟着变成透明，网页才透得出来；
   * 同时把占位文字藏掉——面板现在压在浏览器窗口之上，占位会盖住网页。
   */
  box.classList.toggle('ready', ready)

  // 顶部加载条
  const loadbar = box.querySelector('[data-role="loadbar"]')
  loadbar.classList.toggle('active', status === 'starting')

  // 占位内容（浏览器窗口就位后被覆盖，看不到）
  const ph = box.querySelector('[data-role="placeholder"]')
  if (status === 'failed') {
    ph.className = 'pane-placeholder error'
    ph.textContent = `加载失败：${state.statuses[paneId]?.error || '未知错误'}\n点击下方按钮可重新加载该 AI`
  }
  else if (status === 'suspended') {
    ph.className = 'pane-placeholder'
    ph.textContent = `${ai ? ai.name : ''} 已休眠（切换到该格可唤醒）`
  }
  else {
    ph.className = 'pane-placeholder'
    ph.textContent = ai ? `正在启动 ${ai.name} 浏览器实例…` : '未选择 AI'
  }

  // 选择器外观
  const btn = box.querySelector('[data-role="aitrigger"]')
  btn.innerHTML = ''
  btn.appendChild(buildLogo(ai))
  btn.appendChild(el('span', 'label', ai ? ai.name : '选择 AI'))
  const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  caret.setAttribute('class', 'caret')
  caret.setAttribute('viewBox', '0 0 24 24')
  caret.setAttribute('fill', 'none')
  caret.setAttribute('stroke', 'currentColor')
  caret.setAttribute('stroke-width', '2.4')
  caret.setAttribute('stroke-linecap', 'round')
  const cp = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  cp.setAttribute('d', 'M6 9.5 12 15.5 18 9.5')
  caret.appendChild(cp)
  btn.appendChild(caret)
  btn.classList.toggle('open', state.menuPane === paneId)

  // 下拉内容
  renderMenu(paneId)

  // 切换器的宽度会随 AI 名字变化（锚点矩形跟着变），重新上报一次
  scheduleReportRects()
}

/** 合并短时间内的多次上报请求（切换器尺寸变化、状态刷新都可能触发） */
let reportTimer = null
function scheduleReportRects() {
  if (reportTimer) clearTimeout(reportTimer)
  reportTimer = setTimeout(() => { reportTimer = null; reportRects() }, 120)
}

function renderMenu(paneId) {
  const box = document.querySelector(`.pane[data-pane-id="${paneId}"]`)
  if (!box) return
  const menu = box.querySelector('[data-role="aimenu"]')
  const pane = state.config.panes.find((p) => p.id === paneId)
  menu.innerHTML = ''

  const groups = [
    { key: 'us', title: '国外 AI' },
    { key: 'cn', title: '国内 AI' },
  ]
  /**
   * 隐藏的 AI 不出现在选择器里（设置页里手动收起来的那些）。
   * 注意只过滤**候选**列表：已经开着的格子若正好绑着一个被隐藏的 AI，
   * 它照常显示、照常能用——"隐藏"不等于"禁用"，收起的同时不能把人家的格子弄坏。
   */
  let shown = 0
  for (const g of groups) {
    const list = state.config.aiList.filter((a) => (a.category || 'cn') === g.key && !a.hidden)
    if (!list.length) continue
    menu.appendChild(el('div', 'group-title', g.title))
    for (const ai of list) {
      shown += 1
      const row = el('div', `ai-option${ai.id === pane?.aiId ? ' selected' : ''}`)
      row.appendChild(buildLogo(ai, 20))
      row.appendChild(el('span', 'name', ai.name))
      if (ai.id === pane?.aiId) row.appendChild(el('span', 'tick', '✓'))
      row.addEventListener('click', async (e) => {
        e.stopPropagation()
        toggleMenu(null)
        if (ai.id === pane?.aiId) return
        await api.setPaneAi(paneId, ai.id)
      })
      menu.appendChild(row)
    }
  }
  if (!shown) {
    menu.appendChild(el('div', 'group-title', '所有 AI 都隐藏了'))
    menu.appendChild(el('div', 'ai-option muted', '到设置 → AI 服务里把需要的显示回来'))
  }
}

/* ---------------- 下拉开关（需临时遮挡原生浏览器窗口） ---------------- */

function toggleMenu(paneId) {
  const prev = state.menuPane
  if (prev === paneId) return
  state.menuPane = paneId

  if (prev) {
    document.querySelector(`.pane[data-pane-id="${prev}"]`)?.classList.remove('menu-open')
    // 先把菜单内容渲染回原样再撤掉遮挡，避免读到过期尺寸
    updatePane(prev)
    setOcclude(prev, false)
  }
  if (paneId) {
    document.querySelector(`.pane[data-pane-id="${paneId}"]`)?.classList.add('menu-open')
    // 顺序很重要：先展开并渲染菜单，拿到最终尺寸后再去原生窗口上"挖洞"
    updatePane(paneId)
    setOcclude(paneId, true)
  }
  // 开合之后都要立刻按当前指针位置重定一次穿透：
  // 菜单开着 → 面板收回鼠标（点在网页上也能收菜单）；收起来了 → 把网页的点击还回去
  syncPassthrough()
}

/**
 * 让该格的原生浏览器窗口给浮层让位。
 *
 * 不再整窗隐藏：把下拉菜单那一块矩形从浏览器窗口的可视区域里挖掉即可，
 * 页面其余部分依然可见——观感接近"下拉浮在网页之上"。
 * 只有在拿不到菜单尺寸时才退化为整窗隐藏（保证浮层一定可见）。
 */
function setOcclude(paneId, on) {
  // 只有已经嵌入真实浏览器窗口的格子才需要处理
  if (!state.readyPanes.has(paneId)) return

  let hole = null
  if (on) {
    const box = document.querySelector(`.pane[data-pane-id="${paneId}"]`)
    const menu = box?.querySelector('[data-role="aimenu"]')
    const pr = box?.getBoundingClientRect()
    const mr = menu?.getBoundingClientRect()
    if (pr && mr && mr.width > 4 && mr.height > 4) {
      // 菜单矩形 → 分格内容区坐标。内容区的上/左边与分格一致
      //（app.js 只把底部 PANE_FOOTER 那条留给切换器）
      hole = {
        x: Math.round(mr.left - pr.left),
        y: Math.round(mr.top - pr.top),
        width: Math.round(mr.width),
        height: Math.round(mr.height),
      }
    }
  }
  api.paneOcclude(paneId, on, hole)
}

/* ---------------- 网格 ---------------- */

function buildGrid() {
  const wrap = document.getElementById('panes')
  if (!wrap || !state.config) return
  state.paneIds = visiblePaneIds()
  wrap.className = `size-${state.config.layout}`
  wrap.innerHTML = ''
  for (const id of state.paneIds) wrap.appendChild(buildPane(id))
  for (const id of state.paneIds) updatePane(id)
  reportRects()
}

function reportRects() {
  const rects = []
  for (const id of state.paneIds) {
    const box = document.querySelector(`.pane[data-pane-id="${id}"]`)
    if (!box) continue
    const r = box.getBoundingClientRect()
    // 底部还给切换器的那条：现在恒为 0，浏览器窗口直接铺满整格
    const height = Math.max(0, Math.round(r.height) - PANE_FOOTER)
    /**
     * 悬浮的 AI 切换器（"灵动岛"）矩形，随分格矩形一起上报。
     *
     * 它是面板画的，而原生浏览器窗口永远在面板之上，所以必须请主进程
     * 把这一小块从浏览器窗口挖掉，否则切换器会被网页整个盖住。
     * 坐标原点与分格内容区一致（就是分格的左上角）。
     */
    const pill = box.querySelector('.ai-selector')
    const pr = pill?.getBoundingClientRect()
    const anchor = pr && pr.width > 4 && pr.height > 4
      ? {
          x: Math.round(pr.left - r.left),
          y: Math.round(pr.top - r.top),
          width: Math.round(pr.width),
          height: Math.round(pr.height),
        }
      : null
    rects.push({
      paneId: id,
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height,
      anchor,
    })
  }
  if (!rects.length) return
  // 内容没变就别往主进程推：状态刷新会频繁触发本函数，
  // 每次都让主进程重算并重设窗口区域会造成无谓的闪烁风险。
  const key = JSON.stringify(rects)
  if (key === lastRectsKey) return
  lastRectsKey = key
  api.paneRects(rects)
}
let lastRectsKey = ''

/* ---------------- 配置应用 ---------------- */

function applyConfig(cfg) {
  const prevIds = state.paneIds.join(',')
  const prevLayout = state.config?.layout
  state.config = cfg

  const nextIds = visiblePaneIds().join(',')
  const idsChanged = prevIds !== nextIds
  const needRebuild = idsChanged || !document.querySelector('#panes .pane') || prevLayout === undefined

  if (needRebuild) {
    if (state.menuPane) toggleMenu(null)
    buildGrid()
  }
  else {
    for (const id of state.paneIds) updatePane(id)
  }

  for (const b of document.querySelectorAll('[data-layout]')) {
    b.classList.toggle('active', b.dataset.layout === String(cfg.layout))
  }
  // 置顶开关跟随配置（设置页改了这里也会跟着变）
  const pin = document.getElementById('btn-pin')
  if (pin) {
    const on = cfg.alwaysOnTop !== false
    pin.classList.toggle('active', on)
    pin.title = on ? '面板置顶（点击取消置顶）' : '面板未置顶（点击置顶）'
  }
}

/* ---------------- 初始化 ---------------- */

async function init() {
  const cfg = await api.getConfig()
  applyConfig(cfg)

  api.on('config-updated', (next) => applyConfig(next))
  api.on('instances-updated', (list) => {
    const map = {}
    for (const it of list) map[it.paneId] = it
    state.statuses = map
    for (const id of state.paneIds) updatePane(id)
  })
  api.on('request-rects', () => reportRects())
  api.on('panel-shown', () => {
    // 收起再呼出时不该还挂着上一次展开的列表
    if (state.menuPane) toggleMenu(null)
    reportRects()
    /**
     * 只把穿透缓存作废，**不要**拿手上的点位主动上报一次。
     *
     * `pointerAt` 只在 mousemove 时更新；面板收起期间指针挪过的话它就是个**陈旧值**，
     * 拿它算出的穿透状态会把主进程刚算对的结果覆盖掉——实测日志里看得清清楚楚：
     * `+326ms` 主进程判对 `true`，`+328ms` 被渲染层的陈旧点位覆盖成 `false`，
     * 面板于是又把鼠标收走，正是"呼出后点不动"的另一种成因。
     *
     * 主进程手上有 `screen.getCursorScreenPoint()`（永远新鲜），"呼出后这一下算哪边"
     * 整个交给它（见 showPanel 的逐帧精算与 settleAfterShow）。
     * 作废缓存就够了：等指针真的动起来，`setPassthrough` 不会再被"值没变"短路，
     * 必定重算并上报。
     */
    passthrough = null
  })
  // 点在面板外面（别的窗口 / 桌面）：这条由主进程的前台窗口事件转发过来
  api.on('outside-click', () => {
    if (state.menuPane) toggleMenu(null)
  })
  api.on('layout-changed', () => {
    applyConfig(state.config)
    reportRects()
  })

  window.addEventListener('resize', () => setTimeout(reportRects, 60))
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.menuPane) toggleMenu(null)
      else api.panelHide()
    }
  })
  document.addEventListener('click', () => {
    if (state.menuPane) toggleMenu(null)
  })

  for (const b of document.querySelectorAll('[data-layout]')) {
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      api.setLayout(b.dataset.layout)
    })
  }
  const pin = document.getElementById('btn-pin')
  pin?.addEventListener('click', (e) => {
    e.stopPropagation()
    // 面板要不要压在别的程序之上交给用户决定：关掉之后如果不希望再被面板挡着，
    // 这一下正好把它放回到普通窗口层级
    api.setAlwaysOnTop(!state.config.alwaysOnTop)
  })
  document.getElementById('btn-settings')?.addEventListener('click', (e) => {
    e.stopPropagation()
    api.openSettings()
  })
  document.getElementById('btn-hide')?.addEventListener('click', (e) => {
    e.stopPropagation()
    api.panelHide()
  })

  bindHeaderDrag()

  // 窗口移动/缩放后同步格子位置
  setInterval(reportRects, 2000)
}

/**
 * 顶栏拖动面板。
 *
 * 不用 `-webkit-app-region: drag`：那等于告诉系统"这块是标题栏"，系统就会
 * 按自己的标题栏配色重画一遍，Win11 上直接把深色顶栏盖成一条浅色带，
 * 顶栏文字随之消失（按钮却还能点）。这里改成自己算位移：
 *   · 在顶栏按下（不含按钮）→ 记下起点，并 setPointerCapture 住指针；
 *   · pointermove → 把相对位移交给主进程挪窗口；
 *   · pointerup / 指针被系统抢走 → 结束。
 * pointer capture 的好处是指针移出窗口也不断流，位移不会中途丢帧。
 */
function bindHeaderDrag() {
  const header = document.querySelector('.setting-header')
  if (!header) return

  let drag = null
  let raf = 0
  let last = { dx: 0, dy: 0 }

  const flush = () => {
    raf = 0
    api.panelDragMove(last.dx, last.dy)
  }

  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    if (e.target.closest('button')) return
    drag = { id: e.pointerId, x: e.screenX, y: e.screenY }
    last = { dx: 0, dy: 0 }
    try { header.setPointerCapture(e.pointerId) } catch { /* 忽略：拿不到也还能靠 document 事件走 */ }
    api.panelDragStart()
    e.preventDefault()
  })

  header.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return
    last = { dx: e.screenX - drag.x, dy: e.screenY - drag.y }
    // 合到一帧里发一次：指针事件比屏幕刷新快，逐条发会把主进程刷爆
    if (!raf) raf = requestAnimationFrame(flush)
  })

  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return
    drag = null
    if (raf) { cancelAnimationFrame(raf); flush() }
    api.panelDragEnd()
  }
  header.addEventListener('pointerup', end)
  header.addEventListener('pointercancel', end)
  header.addEventListener('lostpointercapture', end)
}

init()
