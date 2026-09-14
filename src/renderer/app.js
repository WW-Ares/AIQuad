/* AI 助手面板渲染层：顶栏图标按钮 + 分格网格 + 每格底部悬浮 AI 选择器 */
const api = window.aiquad

const LAYOUT_COUNT = { '1': 1, '2': 2, '4': 4 }

/**
 * 每格底部为 AI 切换器预留的高度（CSS px）。
 * 真实浏览器窗口是原生子窗口，始终绘制在 Electron 内容之上，
 * 所以切换器不能像网页那样浮在页面上——只能把它下面这块留给面板自己画。
 */
const PANE_FOOTER = 46

const state = {
  config: null,
  paneIds: [],
  statuses: {},
  /** 当前展开下拉的格子 */
  menuPane: null,
  /** 已就位的格子（浏览器窗口已嵌入，可遮挡原生窗口） */
  readyPanes: new Set(),
}

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
  for (const g of groups) {
    const list = state.config.aiList.filter((a) => (a.category || 'cn') === g.key)
    if (!list.length) continue
    menu.appendChild(el('div', 'group-title', g.title))
    for (const ai of list) {
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
    // 底部留给 AI 切换器：真实浏览器窗口只占上方「内容区」，
    // 否则原生子窗口会把这个切换器整个盖住（用户完全看不到）。
    const height = Math.max(0, Math.round(r.height) - PANE_FOOTER)
    rects.push({
      paneId: id,
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height,
    })
  }
  if (rects.length) api.paneRects(rects)
}

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
  document.getElementById('btn-on-top')?.classList.toggle('active', !!cfg.alwaysOnTop)
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
  api.on('panel-shown', () => reportRects())
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
  document.getElementById('btn-settings')?.addEventListener('click', (e) => {
    e.stopPropagation()
    api.openSettings()
  })
  document.getElementById('btn-on-top')?.addEventListener('click', (e) => {
    e.stopPropagation()
    api.setAlwaysOnTop(!state.config.alwaysOnTop)
  })
  document.getElementById('btn-hide')?.addEventListener('click', (e) => {
    e.stopPropagation()
    api.panelHide()
  })

  // 窗口移动/缩放后同步格子位置
  setInterval(reportRects, 2000)
}

init()
