const api = window.aiquad
let cfg = null
let info = null

/**
 * 取元素。
 *
 * ⚠️ 这里必须**防御**：早期版本 `collect()` 里直接读了一个 HTML 中并不存在的
 * `opt-shared`，`null.checked` 抛 TypeError 把整个 `collect()` 打断，
 * 结果是**保存设置时任何一项都不生效**，而且界面上没有任何报错——
 * 用户只能看到"改了没反应"（真实事故：面板宽度比例失效）。
 * 缺元素时返回一个哑对象，宁可这一项不生效，也不能连累其它设置。
 */
const MISSING = {
  value: '',
  checked: false,
  textContent: '',
  innerHTML: '',
  className: '',
  addEventListener() {},
  appendChild() {},
  append() {},
  querySelectorAll: () => [],
  style: {},
}
const $ = (id) => {
  const el = document.getElementById(id)
  if (!el) {
    console.warn(`[settings] HTML 里缺元素 #${id}，该设置项本次不生效`)
    return MISSING
  }
  return el
}

function setRadio(name, value) {
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) {
    r.checked = String(r.value) === String(value)
  }
}

function getRadio(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`)
  return el ? el.value : null
}

/**
 * 快捷键字段清单。id 必须与 settings.html 里的 `.sc-input` 一致，
 * key 必须与主进程 AppConfig.shortcuts 一致（verify-shortcut-capture.js 会审计这一点）。
 */
const SC_FIELDS = [
  { id: 'sc-toggle', key: 'toggleFloat', label: '呼出快捷键' },
  { id: 'sc-1', key: 'layout1', label: '分格切换 1' },
  { id: 'sc-2', key: 'layout2', label: '分格切换 2' },
  { id: 'sc-4', key: 'layout4', label: '分格切换 4' },
]

/** 读抓取控件的真值（`input.value` 在录制态下是提示文案，不能当数据） */
function scGet(id) {
  const el = $(id)
  if (!el || !el.dataset) return ''
  return window.ShortcutCapture ? ShortcutCapture.get(el) : (el.dataset.acc || '')
}

function scSet(id, acc) {
  const el = $(id)
  if (!el || !el.dataset) return
  const v = acc || ''
  if (window.ShortcutCapture) ShortcutCapture.set(el, v)
  else { el.dataset.acc = v; el.value = v }
}

function scStatus(text, kind) {
  const el = $('sc-status')
  el.textContent = text || ''
  el.className = `sc-status${kind ? ` ${kind}` : ''}`
}

/**
 * 本地校验：查重在渲染层就能做（不需要问主进程），
 * "有没有被别的程序占用"必须问主进程（只有它能试注册）。
 */
async function validateShortcuts() {
  // 认领本轮序号：并发的几轮里只有最后一轮能写状态栏，
  // 否则晚回来的旧结论会盖掉新结论，页面上留着一条已经过期的话
  const seq = ++validateSeq
  const seen = new Map()
  const localBad = new Set()
  let duplicateMsg = ''

  for (const f of SC_FIELDS) {
    const el = $(f.id)
    if (!el.dataset) continue
    const acc = scGet(f.id)
    el.classList.remove('bad', 'ok')
    if (!acc) continue
    const norm = window.ShortcutCapture ? ShortcutCapture.normalize(acc) : { ok: true, accelerator: acc }
    if (!norm.ok) {
      localBad.add(f.id)
      duplicateMsg = `${f.label}：${norm.reason}`
      continue
    }
    const low = norm.accelerator.toLowerCase()
    if (seen.has(low)) {
      localBad.add(f.id)
      localBad.add(seen.get(low).id)
      duplicateMsg = `「${seen.get(low).label}」和「${f.label}」都设成了 ${norm.accelerator}，只有前面的那个能生效`
    }
    else {
      seen.set(low, f)
    }
  }

  for (const id of localBad) $(id).classList.add('bad')
  if (duplicateMsg) { scStatus(duplicateMsg, 'err'); return false }

  // 逐个探测是否被其它程序占用（并行，避免串行等待）
  const probes = await Promise.all(SC_FIELDS.map(async (f) => {
    const acc = scGet(f.id)
    if (!acc) return { f, acc, res: { ok: true } }
    try {
      return { f, acc, res: await api.probeShortcut(acc) }
    }
    catch (e) {
      return { f, acc, res: { ok: true, err: String(e) } }
    }
  }))
  // 探测期间又发起了新一轮（用户还在按键）：这一轮的结果已经过期，直接作废
  if (seq !== validateSeq) return false

  const takenList = probes.filter((p) => p.acc && p.res && p.res.ok === false)
  for (const p of probes) {
    const el = $(p.f.id)
    if (!p.acc || !el.dataset) continue
    el.classList.toggle('ok', p.res?.ok !== false)
  }
  if (takenList.length) {
    scStatus(takenList.map((p) => `${p.acc} 已被其它程序占用（${p.f.label}）`).join('；'), 'err')
    return false
  }
  const n = SC_FIELDS.filter((f) => scGet(f.id)).length
  scStatus(n ? `${n} 个快捷键已生效` : '未设置任何快捷键', n ? 'ok' : '')
  return true
}

/** 把主进程回报的注册失败原因显示出来 */
function renderShortcutIssues(issues) {
  if (!Array.isArray(issues) || !issues.length) {
    // 之前这里两个分支都是 return（写错成空操作）：主进程这次没报问题，
    // 但页面上很可能还挂着上一轮的红字。既然是"没有失败项"，就把红字收掉。
    if ($('sc-status').className.includes('err')) scStatus('')
    return
  }
  const text = issues.map((i) => {
    if (i.reason === 'invalid') return `${i.label}「${i.acc}」写法不合法`
    if (i.reason === 'taken') return `${i.acc} 已被其它程序占用（${i.label}）`
    if (i.reason === 'duplicate') return `${i.acc} 与「${i.conflictWith}」重复（${i.label}）`
    return `${i.label} 注册失败`
  }).join('；')
  for (const i of issues) {
    const f = SC_FIELDS.find((x) => x.key === i.key)
    if (f) $(f.id).classList.add('bad')
  }
  scStatus(text, 'err')
}

/**
 * 校验的合并入口。
 *
 * 一次"抓到快捷键"会连着触发两轮校验：控件 onIdle 一次、input 的 change 一次。
 * 两次都去问主进程（试注册）没有必要，而且它们并发跑完的先后顺序不保证——
 * 晚回来的那个会覆盖早回来的，状态栏可能停在一个已经过期的结论上。
 * 所以合并到一个短防抖里，并且只认最后一次的结果（见 validateShortcuts 里的 seq 判断）。
 */
let validateTimer = null
let validateSeq = 0
/** 等这轮校验跑完要做的事（目前只有"通过了就保存"） */
let validateCbs = []
function scheduleValidate(delay = 30, done) {
  if (typeof done === 'function') validateCbs.push(done)
  if (validateTimer) clearTimeout(validateTimer)
  validateTimer = setTimeout(async () => {
    validateTimer = null
    const cbs = validateCbs
    validateCbs = []
    const ok = await validateShortcuts()
    for (const cb of cbs) {
      try {
        cb(ok)
      }
      catch (e) {
        console.warn('[settings] 校验回调出错', e)
      }
    }
  }, delay)
}

function ratioPercent() {
  // 配置里存的是 0~1 的比例，滑块用百分比整数
  const r = Number(cfg.windowWidthRatio)
  const pct = Math.round((Number.isFinite(r) && r > 0 ? r : 0.3) * 100)
  // 夹到滑块量程内：早先用固定档位（20/30/40/50）时，
  // 配置里是 0.42 这种"非档位值"就会**一个都不选中**，保存时被静默重置成 30%
  return Math.min(60, Math.max(20, pct))
}

function fill() {
  // 面板与呼出
  scSet('sc-toggle', cfg.shortcuts.toggleFloat)
  scSet('sc-1', cfg.shortcuts.layout1)
  scSet('sc-2', cfg.shortcuts.layout2)
  scSet('sc-4', cfg.shortcuts.layout4)
  setRadio('position', cfg.position)
  $('ratio').value = ratioPercent()
  $('ratio-val').textContent = `${ratioPercent()}%`
  // 面板必须置顶才能压住浏览器窗口（顶栏、悬浮胶囊都画在面板上）时那条硬约束已放开：
  // 现在交给用户选，关掉之后面板就是一个普通窗口
  $('opt-ontop').checked = cfg.alwaysOnTop !== false
  $('opt-cleanup').checked = cfg.paneCleanup !== false
  $('cleanup-min').value = cfg.paneCleanupDelayMin || 10
  $('opt-autostart').checked = !!cfg.autoStart
  $('opt-hibernate').checked = !!cfg.hibernateBackground

  // 代理
  $('proxy-mode').value = cfg.proxy.mode
  $('proxy-type').value = cfg.proxy.type
  $('proxy-host').value = cfg.proxy.host
  $('proxy-port').value = cfg.proxy.port
  $('proxy-bypass').value = cfg.proxy.bypassList || ''

  // 浏览器
  $('browser-pref').value = cfg.browserPreference
  $('window-mode').value = cfg.windowMode || 'standard'
  $('browser-path').value = cfg.customBrowserPath || ''
  $('opt-shared').checked = cfg.sharedSession !== false
  $('cache-mode').value = cfg.cacheCleanup || 'auto'

  syncRatioUi(ratioPercent())

  if (info?.browser) {
    $('browser-info').textContent = `当前：${info.browser.name} ${info.browser.version || ''}`
  }
  else {
    $('browser-info').textContent = '未检测到 Chrome / Edge，请安装或指定路径'
  }
  const sp = cfg.proxy.systemServer
  $('system-proxy').textContent = sp ? `已检测到：${sp}（类型 ${cfg.proxy.systemType || 'http'}）` : '未检测到系统代理'

  $('about').innerHTML = [
    `AIQuad ${info?.version || '-'} · MIT License · © 2026 WW-Ares`,
    `用户数据：${info?.userData || '-'}`,
    `浏览器档案：${info?.profiles || '-'}`,
    `运行环境：Electron ${info?.electron || '-'} / Node ${info?.node || '-'} / Chromium ${info?.chrome || '-'}`,
  ].join('<br>')

  $('about-oss').innerHTML = [
    '本项目以 MIT 协议开源，源码、打包脚本和回归脚本都公开，欢迎提 issue 与 PR。',
    '用到的开源组件：Electron（MIT，Chromium 内核与窗口管理）、koffi（MIT，直接调用 Windows API 摆放窗口）、electron-updater（MIT，自动更新）。',
    '隐私：纯本地运行，不做数据统计、不上传任何内容；浏览器档案与登录态都在本机的用户数据目录里。',
    '商标：各 AI 的名称与图标归各自所有者，本项目只是在同一面板里打开它们的官网，既不代理账号也不转发对话内容。',
  ].join('<br>')

  // 头部的版本胶囊。窗口标题栏不显示版本，用户报问题时要能一眼念出来
  $('app-ver').textContent = `v${info?.version || '-'}`

  renderAiRows()
  void loadCacheStats()
  syncCleanupDep()
}

/**
 * 「闲置分格自动清理」的分钟数只有在开关打开时才有意义。
 *
 * 关着的时候把分钟框压暗并禁用：一个还能改、但改了完全不生效的输入框，
 * 比一个明显灰掉的更让人困惑（改了没反应 = 以为程序坏了）。
 * 注意**不要**顺手把值也清掉——`collect()` 读的是 `.value`，禁用不影响取值，
 * 用户原来设的分钟数不会因为这个开关被关一下就丢。
 */
function syncCleanupDep() {
  const on = document.getElementById('opt-cleanup')
  const sub = document.getElementById('cleanup-sub')
  const min = document.getElementById('cleanup-min')
  if (!on) return
  const active = !!on.checked
  if (sub) sub.classList.toggle('off', !active)
  if (min) min.disabled = !active
}

/* ---------------- 面板宽度预设 ---------------- */

/**
 * 预设 + 滑块共用一个来源：预设只负责把值写进滑块，剩下的流程完全一致，
 * 免得两套写入路径各自解释一遍"百分比 vs 0~1 的比例"。
 */
const RATIO_PRESETS = [20, 30, 40, 50]

/**
 * 统一宽度 UI。
 *
 * ⚠️ 数字必须**来自传入的值**而不是回读配置：
 * 保存要走 IPC + 可能拖着浏览器实例重启（切换共享登录态时尤其慢），
 * 回调要等好几秒才回来。要是这里回头读 cfg，点一下预设会先按旧值刷新一遍、
 * 隔一会儿才跳到新值，看着像"点了没反应"。
 * 界面先按用户刚点的数落地，磁盘那边的往返结果爱什么时候回来都行。
 */
function syncRatioUi(pct) {
  const value = Number.isFinite(pct) ? pct : Number($('ratio').value)
  const ratio = $('ratio')
  if (ratio.dataset && !ratio.dataset.dragging) ratio.value = value
  $('ratio-val').textContent = `${value}%`
  for (const b of document.querySelectorAll('#ratio-presets button')) {
    b.classList.toggle('active', Number(b.dataset.ratio) === value)
  }
}

function applyRatioPreset(pct) {
  const ratio = $('ratio')
  if (!ratio.dataset) return
  ratio.value = pct
  syncRatioUi(pct)
  void save(false)
}

/* ---------------- 更新 ---------------- */

function updateLabel(s) {
  if (!s) return ''
  switch (s.status) {
    case 'checking': return '正在检查更新…'
    case 'available': return `发现新版本 ${s.version || ''}，正在后台下载…`
    case 'downloading': {
      const mb = s.total ? `（${(s.transferred / 1048576).toFixed(1)} / ${(s.total / 1048576).toFixed(1)} MB）` : ''
      return `正在下载更新 ${s.percent || 0}% ${mb}`
    }
    case 'downloaded': return `新版本 ${s.version || ''} 已下载完成，点上面的按钮安装并重启`
    case 'not-available': return `当前已是最新版本（${s.current}）`
    case 'error': return `检查更新失败：${s.message || '未知错误'}`
    default: return ''
  }
}

function renderUpdate(s) {
  const el = $('update-status')
  if (el) el.textContent = updateLabel(s)
}

function bindUpdate() {
  const btn = $('btn-update')
  if (!btn) return
  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      // 已下载好就直接装（会重启），否则手动查一次
      renderUpdate(await window.aiquad.checkUpdate())
    }
    catch (e) {
      renderUpdate({ status: 'error', message: String(e) })
    }
    finally {
      btn.disabled = false
    }
  })
  window.aiquad.on('update-status', renderUpdate)
  window.aiquad.getUpdateState().then(renderUpdate).catch(() => {})
}

/**
 * 按 id 取当前 cfg 里的 AI 条目。
 *
 * 为什么不能直接用 `renderAiRows` 里闭包捕获的那个 `ai`：`save()` 结尾会把 cfg
 * 整个换成 IPC 回来的新对象（`cfg = res?.config ?? res`），换过之后闭包里的旧对象
 * 就脱离 cfg 了。典型翻车路径：先拖宽度存一次，再去改 AI 名字 / 分类 / 点隐藏，
 * 改的是孤儿对象，collect() 收不到，点保存毫无反应。
 */
function findAi(id) {
  return cfg.aiList.find((a) => a.id === id)
}

/* ---------------- 分组 + 拖动排序 ---------------- */

/**
 * 分组标题的顺序**必须**与分格底部的选择器一致（见 app.js 的 renderMenu）：
 * 国外在前、国内在后。第三组是兜底 —— `category` 被手改成别的值时不能把整行弄丢，
 * 否则用户在界面上再也改不回来。
 */
const AI_GROUPS = [
  { key: 'us', title: '国外 AI' },
  { key: 'cn', title: '国内 AI' },
  { key: null, title: '未分组' },
]

/** 某个条目属于第几组。认不出的值落进兜底组。 */
function aiGroupIndex(ai) {
  const k = ai.category || 'cn'
  const i = AI_GROUPS.findIndex((g) => g.key === k)
  return i < 0 ? AI_GROUPS.length - 1 : i
}

/** 拖柄的六点图标。`fill="currentColor"` 让颜色完全由 CSS 决定（常态淡、悬停亮）。 */
const GRIP_SVG
  = '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">'
  + '<circle cx="2.5" cy="3" r="1.2"/><circle cx="7.5" cy="3" r="1.2"/>'
  + '<circle cx="2.5" cy="8" r="1.2"/><circle cx="7.5" cy="8" r="1.2"/>'
  + '<circle cx="2.5" cy="13" r="1.2"/><circle cx="7.5" cy="13" r="1.2"/>'
  + '</svg>'

let dragId = null
let dropAt = null
let aiDragBound = false

function clearDragUi() {
  const tbody = $('ai-rows')
  const ph = document.getElementById('ai-drop-ph')
  if (ph) ph.remove()
  tbody.querySelectorAll('tr.st-dragging').forEach((r) => r.classList.remove('st-dragging'))
  tbody.querySelectorAll('tr.st-group.over').forEach((r) => r.classList.remove('over'))
  dragId = null
  dropAt = null
}

/** 落点蓝线用的占位行。整行高度为 0，插进表里不会让上面的行跳一下。 */
function dropPlaceholder() {
  let ph = document.getElementById('ai-drop-ph')
  if (ph) return ph
  ph = document.createElement('tr')
  ph.id = 'ai-drop-ph'
  ph.className = 'st-drop'
  const td = document.createElement('td')
  // 列数 = 拖柄 + 名称 + 网址 + 代理 + 操作 = 5，加减列要连这里一起改
  td.colSpan = 5
  td.appendChild(document.createElement('div'))
  ph.appendChild(td)
  return ph
}

/**
 * 指针落在「第几组的第几个位置」。
 *
 * 组 = 最后一个 top 在指针上方的分组标题；位置 = 该组内第一条「中点低于指针」的行之前。
 * 被拖的那一行要**排除在外**（它还在 DOM 里占着位置），否则算出的下标会差一。
 * 这里返回的下标口径 = 「去掉被拖行之后」的位置，与 applyAiReorder 一致。
 */
function dropTargetAt(y) {
  const tbody = $('ai-rows')
  const heads = [...tbody.querySelectorAll('tr.st-group')]
  if (!heads.length) return null
  let gi = 0
  heads.forEach((h, i) => { if (h.getBoundingClientRect().top <= y) gi = i })
  const rows = [...tbody.querySelectorAll('tr.ai-row')]
    .filter((r) => r.dataset.gi === heads[gi].dataset.gi && r.dataset.aiId !== dragId)
  let index = rows.length
  for (let i = 0; i < rows.length; i++) {
    const box = rows[i].getBoundingClientRect()
    if (y < box.top + box.height / 2) { index = i; break }
  }
  return { gi, index, headEl: heads[gi], rows }
}

/** 把蓝线插到算出来的落点上，并把目标组的标题点亮（说明松手会归到这一组） */
function showDropLine(t) {
  const tbody = $('ai-rows')
  const ph = dropPlaceholder()
  const heads = [...tbody.querySelectorAll('tr.st-group')]
  // 落在这组末尾时就插到下一个组标题之前，别越过组边界
  const want = t.rows[t.index] || heads[t.gi + 1] || null
  // dragover 是跟着鼠标频率来的：落点没变就别动 DOM（insertBefore 会触发重排）
  if (ph.parentNode !== tbody || ph.nextSibling !== want) tbody.insertBefore(ph, want)
  heads.forEach((h, i) => h.classList.toggle('over', i === t.gi))
}

/**
 * 把条目挪到「第 gi 组的第 index 个位置」。
 *
 * ⚠️ 不用「先按组排序、再整体重排」来简化：数组里各组的条目本来就可能交错
 * （老配置、以及用户一次只挪一条），整体重排会顺带改掉用户没碰过的顺序。
 * 做法：先把被拖的摘出来，再在**剩下的**数组里找「目标位置那条」当锚点、插到它前面；
 * 落点在该组末尾时，锚点换成「组顺序比它更靠后的第一条」。
 */
function applyAiReorder(id, gi, index) {
  const item = cfg.aiList.find((a) => a.id === id)
  if (!item) return false
  const rest = cfg.aiList.filter((a) => a.id !== id)
  const key = AI_GROUPS[gi]?.key ?? null
  // 跨组拖动顺带改分组。兜底组的 key 是 null，不改（否则会把 category 写成 null）
  if (key !== null && (item.category || 'cn') !== key) item.category = key
  const members = rest.filter((a) => aiGroupIndex(a) === gi)
  const anchor = members[index]
  let at
  if (anchor) at = rest.indexOf(anchor)
  else {
    const last = members[members.length - 1]
    if (last) at = rest.indexOf(last) + 1
    else {
      const later = rest.find((a) => aiGroupIndex(a) > gi)
      at = later ? rest.indexOf(later) : rest.length
    }
  }
  rest.splice(at, 0, item)
  cfg.aiList = rest
  return true
}

/**
 * 拖动排序。用 HTML5 原生拖放（`draggable` + `dragover`/`drop`），
 * 而不是拿 pointer 事件重造一套 —— 原生那套自带拖影、跨行移动、Esc 取消。
 *
 * 只在**拖柄**上挂 `draggable`，整行不挂：否则想选中名称里的文字就会误触发拖动。
 * 事件全挂在 tbody 上做委托 —— `renderAiRows()` 每次都把行重建，挂在行上会跟着丢。
 *
 * 拖动**只写配置、不碰浏览器**：主进程 `save-config` 的重启判据只认
 * 代理 / 窗口形态 / 登录态共享 / 浏览器选择（见 main/index.ts），`syncInstances()`
 * 也是按「格子的 aiId 有没有变」做差量的 —— 所以重排不会把分格里的网页重开。
 */
function bindAiDrag() {
  if (aiDragBound) return
  aiDragBound = true
  const tbody = $('ai-rows')

  tbody.addEventListener('dragstart', (e) => {
    const grip = e.target?.closest?.('.st-grip')
    if (!grip) return
    const tr = grip.closest('tr')
    dragId = tr?.dataset?.aiId || null
    if (!dragId) return
    e.dataTransfer.effectAllowed = 'move'
    // 不带文本时 Firefox 不会启动拖放（Chromium 只是无害地带上）
    e.dataTransfer.setData('text/plain', dragId)
    // 拖影取整行，而不是那个 10×16 的小抓手
    try {
      const g = grip.getBoundingClientRect()
      const r = tr.getBoundingClientRect()
      e.dataTransfer.setDragImage(tr, g.left + g.width / 2 - r.left, g.top + g.height / 2 - r.top)
    }
    catch {}
    // 类名要等拖影拍完再加（拖影是 dragstart 同步拍的），否则拖起来的那份残影也是半透明的
    setTimeout(() => tr.classList.add('st-dragging'), 0)
  })

  tbody.addEventListener('dragover', (e) => {
    if (!dragId) return
    // 不 preventDefault 就收不到 drop
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const t = dropTargetAt(e.clientY)
    if (!t) return
    dropAt = t
    showDropLine(t)
  })

  tbody.addEventListener('drop', async (e) => {
    if (!dragId || !dropAt) return
    e.preventDefault()
    const id = dragId
    const { gi, index } = dropAt
    clearDragUi()
    if (!applyAiReorder(id, gi, index)) return
    // 先按新顺序重画（手感上立刻到位），落库回来再对一次：
    // 万一主进程那边把配置整过形，界面不会跟真实配置脱节
    renderAiRows()
    await save(false)
    renderAiRows()
  })

  tbody.addEventListener('dragend', () => clearDragUi())
}

function renderAiRows() {
  const tbody = $('ai-rows')
  tbody.innerHTML = ''
  bindAiDrag()

  /**
   * 按分组分块渲染，而不是直接按数组顺序平铺。
   *
   * 分格底部的选择器是「先按分组过滤、再按数组顺序排」的（见 app.js renderMenu），
   * 组间位置由 category 决定、不由数组位置决定。平铺时把一条拖过组界，选择器里
   * 只会看到「组内先后」变了，像"没拖到那么远" —— 分成块之后拖动才所见即所得。
   *
   * 摊成一个 slots 序列（组标题 + 组内各行）而不是写两层循环，是为了让下面这段
   * 逐行构建的代码保持原样。
   */
  const slots = []
  for (let gi = 0; gi < AI_GROUPS.length; gi++) {
    const items = cfg.aiList.filter((a) => aiGroupIndex(a) === gi)
    // 兜底组空着就不画标题，免得平时多出一行莫名其妙的「未分组」
    if (!items.length && AI_GROUPS[gi].key === null) continue
    slots.push({ gi, head: AI_GROUPS[gi].title })
    for (const ai of items) slots.push({ gi, ai })
  }

  for (const slot of slots) {
    if (slot.head) {
      const head = document.createElement('tr')
      head.className = 'st-group'
      head.dataset.gi = String(slot.gi)
      const headTd = document.createElement('td')
      headTd.colSpan = 5
      headTd.textContent = slot.head
      head.appendChild(headTd)
      tbody.appendChild(head)
      continue
    }

    const ai = slot.ai
    // 隐藏项整体压暗，一眼能看出"它还在，但不在选择器里"
    const tr = document.createElement('tr')
    tr.className = ai.hidden ? 'ai-row ai-hidden' : 'ai-row'
    tr.dataset.aiId = ai.id
    tr.dataset.gi = String(slot.gi)

    /**
     * 拖柄列。只在**它自己**身上挂 draggable —— 整行可拖的话，
     * 想用鼠标选中名称/网址里的文字就会变成拖动。
     */
    const tdGrip = document.createElement('td')
    tdGrip.className = 'c-grip'
    const grip = document.createElement('span')
    grip.className = 'st-grip'
    grip.draggable = true
    grip.title = '按住拖动可调整顺序；拖到另一组的标题下会改归那一组'
    grip.innerHTML = GRIP_SVG
    tdGrip.appendChild(grip)

    const tdName = document.createElement('td')
    tdName.className = 'c-name'
    const inName = document.createElement('input')
    inName.value = ai.name
    inName.addEventListener('change', () => {
      const cur = findAi(ai.id)
      if (cur) cur.name = inName.value
      scheduleSave(200)
    })
    tdName.appendChild(inName)

    const tdUrl = document.createElement('td')
    tdUrl.className = 'c-url'
    const inUrl = document.createElement('input')
    inUrl.value = ai.url
    inUrl.addEventListener('change', () => {
      const cur = findAi(ai.id)
      if (cur) cur.url = inUrl.value
      scheduleSave(200)
    })
    tdUrl.appendChild(inUrl)

    const tdProxy = document.createElement('td')
    const sel = document.createElement('select')
    for (const [v, t] of [['global', '跟随全局'], ['direct', '直连'], ['custom', '单独代理']]) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = t
      if (ai.proxyMode === v) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => {
      const cur = findAi(ai.id)
      if (!cur) return
      cur.proxyMode = sel.value
      if (cur.proxyMode === 'custom' && !cur.proxy) {
        cur.proxy = { mode: 'custom', type: 'http', host: '', port: '', bypassList: '' }
      }
      scheduleSave(0)
      renderAiRows()
    })
    tdProxy.appendChild(sel)

    const tdOp = document.createElement('td')
    tdOp.className = 'ops'

    const hide = document.createElement('button')
    hide.textContent = ai.hidden ? '显示' : '隐藏'
    hide.title = ai.hidden ? '放回分格底部的选择器' : '只从选择器里摘掉，正在用的格子不受影响'
    hide.addEventListener('click', async () => {
      const cur = findAi(ai.id)
      if (!cur) return
      cur.hidden = !cur.hidden
      await save(false)
      renderAiRows()
    })

    const del = document.createElement('button')
    del.textContent = '删除'
    del.className = 'btn-danger'
    del.addEventListener('click', async () => {
      const cur = findAi(ai.id)
      const used = cfg.panes.filter((p) => p.aiId === ai.id).map((p) => p.id)
      const warn = used.length
        ? `\n\n它正绑定在 ${used.join(' / ')} 格，删除后这些格子会自动换一个 AI。`
        : ''
      if (!confirm(`确定删除「${cur?.name ?? ai.name}」？${warn}`)) return
      cfg.aiList = cfg.aiList.filter((a) => a.id !== ai.id)
      await save(false)
      renderAiRows()
    })

    tdOp.append(hide, del)

    tr.append(tdGrip, tdName, tdUrl, tdProxy, tdOp)
    tbody.appendChild(tr)

    if (ai.proxyMode === 'custom') {
      const tr2 = document.createElement('tr')
      const td = document.createElement('td')
      // ⚠️ 列数 = 拖柄 + 名称 + 网址 + 代理 + 操作 = 5，加/减列要连这里一起改
      td.colSpan = 5
      const sel2 = document.createElement('select')
      for (const v of ['http', 'https', 'socks5']) {
        const o = document.createElement('option')
        o.value = v
        o.textContent = v.toUpperCase()
        if (ai.proxy?.type === v) o.selected = true
        sel2.appendChild(o)
      }
      sel2.addEventListener('change', () => {
        const cur = findAi(ai.id)?.proxy
        if (cur) cur.type = sel2.value
        scheduleSave(0)
      })
      const host = document.createElement('input')
      host.placeholder = '127.0.0.1'
      host.style.width = '140px'
      host.value = ai.proxy?.host || ''
      host.addEventListener('change', () => {
        const cur = findAi(ai.id)?.proxy
        if (cur) cur.host = host.value
        scheduleSave(150)
      })
      const port = document.createElement('input')
      port.placeholder = '端口'
      port.style.width = '90px'
      port.value = ai.proxy?.port || ''
      port.addEventListener('change', () => {
        const cur = findAi(ai.id)?.proxy
        if (cur) cur.port = port.value
        scheduleSave(150)
      })
      td.append(document.createTextNode(' 单独代理：'), sel2, host, port)
      tr2.appendChild(td)
      tbody.appendChild(tr2)
    }
  }
}

function collect() {
  cfg.browserPreference = $('browser-pref').value
  cfg.windowMode = $('window-mode').value
  cfg.sharedSession = $('opt-shared').checked
  cfg.customBrowserPath = $('browser-path').value.trim()
  cfg.proxy.mode = $('proxy-mode').value
  cfg.proxy.type = $('proxy-type').value
  cfg.proxy.host = $('proxy-host').value.trim()
  cfg.proxy.port = $('proxy-port').value.trim()
  cfg.proxy.bypassList = $('proxy-bypass').value.trim()
  // 快捷键：读抓取控件的真值。**不再**用 `|| 默认值` 兜底——
  // 那样用户想清空（= 禁用某个键）时会静默变回默认值，看起来像"清不掉"。
  cfg.shortcuts = {}
  for (const f of SC_FIELDS) cfg.shortcuts[f.key] = scGet(f.id)
  cfg.position = getRadio('position') || 'right'
  cfg.windowWidthRatio = Number($('ratio').value || 30) / 100
  cfg.cacheCleanup = $('cache-mode').value || 'auto'
  // 面板要不要压在别的程序之上，由用户决定（早先恒为 true）
  cfg.alwaysOnTop = $('opt-ontop').checked
  cfg.autoStart = $('opt-autostart').checked
  cfg.hibernateBackground = $('opt-hibernate').checked
  cfg.paneCleanup = $('opt-cleanup').checked
  cfg.paneCleanupDelayMin = Math.min(120, Math.max(1, Number($('cleanup-min').value) || 10))
  return cfg
}

/**
 * 自动保存（取代原来的"保存并应用"按钮）。
 *
 * 合到一次 tick 里发：同一个控件连续改动（或一次 `change` 里连着改几项）只会有一次 IPC。
 * 延迟不为零是有意的——保存会把配置写给主进程，代理 / 浏览器这类改动还要连带
 * 重启实例，在一串改动的中途反复触发没有意义。
 */
let autoSaveTimer = null
let saveFlashTimer = null
function scheduleSave(delay = 200) {
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null
    void save(false)
  }, delay)
}

async function save(showResult = true) {
  const r = $('save-result')
  try {
    const next = collect()
    const res = await api.saveConfig(next)
    // 主进程返回值从"配置"改成 `{ config, shortcutIssues }`：
    // 快捷键注册失败必须回传，否则用户只会看到"按了没反应"
    cfg = res?.config ?? res
    await api.syncInstances()
    renderShortcutIssues(res?.shortcutIssues || [])
    if (showResult) {
      r.textContent = res?.shortcutIssues?.length ? '已保存，但有快捷键没生效' : '已保存并应用'
      r.className = res?.shortcutIssues?.length ? 'result err' : 'result ok'
      if (saveFlashTimer) clearTimeout(saveFlashTimer)
      saveFlashTimer = setTimeout(() => { r.textContent = '' }, 2500)
      return
    }
    // 后台自动保存：给一个很快就淡掉的提示，让用户知道改动已经落盘了
    r.textContent = res?.shortcutIssues?.length ? '已自动保存，但有快捷键没生效' : '已自动保存'
    r.className = res?.shortcutIssues?.length ? 'result err' : 'result ok'
    if (saveFlashTimer) clearTimeout(saveFlashTimer)
    saveFlashTimer = setTimeout(() => { r.textContent = '' }, 1600)
  }
  catch (e) {
    // 任何一步失败都要**说出来**。以前这里静默失败，用户只能看到"改了没反应"，
    // 连是不是保存了都无从判断。
    console.error('[settings] 保存失败', e)
    r.textContent = `保存失败：${e?.message || e}`
    r.className = 'result err'
  }
}

async function init() {
  cfg = await api.getConfig()
  info = await api.getAppInfo()

  // 快捷键抓取控件必须在 fill() 之前初始化，否则 fill() 设的值会被覆盖。
  // onIdle：录制结束（抓到键 / Esc 取消 / 失焦）后重新校验一遍，
  // 不然那句"录制中"或红色警告会一直挂在页面上。
  if (window.ShortcutCapture) ShortcutCapture.init(document, { onIdle: () => scheduleValidate() })
  fill()

  bindAutoSave()
  // 清理开关一翻，分钟框跟着亮/灭（bindAutoSave 也绑了这个 id，各管各的，互不影响）
  document.getElementById('opt-cleanup')?.addEventListener('change', syncCleanupDep)

  // 抓取到一个组合后：先本地校验（重复/缺修饰键），再问主进程（是否被占用），
  // 都过了才自动保存，让用户当场就能按下去试。
  for (const f of SC_FIELDS) {
    const el = document.getElementById(f.id)
    if (!el) continue
    // 也走防抖：抓一次键会同时触发 onIdle 与 change，各自起一轮校验的话，
    // 先跑的那轮会被序号判为过期，保存就被吞掉了。合到一轮里，跑完再决定存不存。
    el.addEventListener('change', () => {
      scheduleValidate(30, (ok) => { if (ok) void save(false) })
    })
  }
  // 启动时注册失败的项（比如组合已被系统占用）也要显示出来
  try {
    renderShortcutIssues(await api.shortcutIssues())
  }
  catch {}
  if (!$('sc-status').textContent) await validateShortcuts()

  $('btn-add-ai').addEventListener('click', async () => {
    const name = $('new-ai-name').value.trim()
    const url = $('new-ai-url').value.trim()
    if (!name || !url) return
    cfg.aiList.push({
      id: `custom_${Date.now()}`,
      name,
      url: url.startsWith('http') ? url : `https://${url}`,
      category: $('new-ai-category').value,
      logo: '',
      proxyMode: $('new-ai-proxy').value,
    })
    $('new-ai-name').value = ''
    $('new-ai-url').value = ''
    await save(false)
    renderAiRows()
  })

  const toggle = $('btn-test-proxy')
  toggle.addEventListener('click', async (ev) => {
    const el = $('proxy-result')
    const btn = ev?.currentTarget || null
    const url = String($('proxy-test-url').value || '').trim() || 'https://www.google.com'
    if (btn && btn.dataset) btn.disabled = true
    let watchdog = null
    el.className = 'result'
    el.textContent = `测试中…（${url.replace(/^https?:\/\//, '')}，最多 15 秒）`
    try {
      const p = collect().proxy
      /**
       * 主进程那边有 10 秒硬超时。
       * 这里再兜一道 15 秒：万一 IPC 本身出问题（渲染进程卡死、主进程异常重启），
       * 界面也不会永远停在"测试中…"——之前就是这么卡的。
       */
      const r = await Promise.race([
        api.testProxy(p, url),
        new Promise((_, rej) => {
          watchdog = setTimeout(() => rej(new Error('等待超时（15 秒）')), 15000)
        }),
      ])
      const extra = [r.via, r.detail].filter(Boolean).join(' · ')
      el.textContent = r.ok
        ? `通过（${r.ms}ms${extra ? ` · ${extra}` : ''}）`
        : `失败：${r.error || '未知错误'}${extra ? ` · ${extra}` : ''}`
      el.className = r.ok ? 'result ok' : 'result err'
    }
    catch (e) {
      // 走到这里说明连结果都没拿回来，一定要说出来，不能留一个永恒的"测试中…"
      el.textContent = `测试出错：${String(e?.message || e)}`
      el.className = 'result err'
    }
    finally {
      if (watchdog) clearTimeout(watchdog)
      if (btn && btn.dataset) btn.disabled = false
    }
  })

  $('btn-open-profiles').addEventListener('click', () => api.openPath(info.profiles))

  // 关于页的外链一律走系统浏览器，别在设置窗口里开自己也加载不了的页面
  for (const a of document.querySelectorAll('[data-open]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      api.openExternal(a.dataset.open)
    })
  }

  bindCache()
  bindRatioPresets()

  bindUpdate()

  // 位置 / 宽度比例改动后立即预览效果
  for (const r of document.querySelectorAll('input[name="position"]')) {
    r.addEventListener('change', () => save(false))
  }
}

/* ---------------- 自动保存 ---------------- */

/**
 * 所有改动即时落盘，没有"保存并应用"这一步了。
 *
 * 下拉 / 勾选 / 单选：change 立刻存。
 * 文本框：只在 change（失焦或回车）时存，**不监听 input** —— 代理主机、端口这类
 * 字段一改动就会触发浏览器实例重启，边打字边重启是不可接受的。
 */
function bindAutoSave() {
  const instant = ['proxy-mode', 'proxy-type', 'browser-pref', 'window-mode', 'opt-shared']
  const text = ['proxy-host', 'proxy-port', 'proxy-bypass', 'browser-path', 'cleanup-min']
  const toggles = ['opt-ontop', 'opt-autostart', 'opt-hibernate', 'opt-cleanup']

  for (const id of instant) {
    document.getElementById(id)?.addEventListener('change', () => scheduleSave(0))
  }
  for (const id of toggles) {
    document.getElementById(id)?.addEventListener('change', () => scheduleSave(0))
  }
  for (const id of text) {
    document.getElementById(id)?.addEventListener('change', () => scheduleSave(150))
  }
}

/* ---------------- 面板宽度预设 ---------------- */

function bindRatioPresets() {
  for (const b of document.querySelectorAll('#ratio-presets button')) {
    b.addEventListener('click', () => applyRatioPreset(Number(b.dataset.ratio || RATIO_PRESETS[1])))
  }
  // 滑块：拖动中只更新数字（光标还没放开，别去重启实例），松手才落定
  const ratio = document.getElementById('ratio')
  if (ratio) {
    ratio.addEventListener('input', () => {
      ratio.dataset.dragging = '1'
      syncRatioUi(Number(ratio.value))
    })
    const settle = () => {
      if (!ratio.dataset.dragging) return
      delete ratio.dataset.dragging
      void save(false)
    }
    ratio.addEventListener('change', settle)
    ratio.addEventListener('pointerup', settle)
    ratio.addEventListener('pointercancel', settle)
    ratio.addEventListener('blur', settle)
  }
}

/* ---------------- 数据与缓存 ---------------- */

function fmtBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

async function loadCacheStats() {
  try {
    const s = await api.getCacheStats()
    $('cache-stat').textContent = `${s.profileCount} 份档案 · 共 ${fmtBytes(s.totalBytes)} · 可清理缓存 ${fmtBytes(s.cacheBytes)}`
    const top = (s.profiles || []).filter((p) => p.cacheBytes > 0).slice(0, 4)
    $('cache-detail').innerHTML = top.length
      ? top.map((p) => `${p.name}：缓存 ${fmtBytes(p.cacheBytes)}，档案合计 ${fmtBytes(p.totalBytes)}`).join('<br>')
      : '暂时没有可清理的缓存'
  }
  catch (e) {
    $('cache-stat').textContent = '统计失败'
    $('cache-detail').textContent = String(e?.message || e)
  }
}

function bindCache() {
  $('cache-mode').addEventListener('change', () => save(false))

  $('btn-clear-cache').addEventListener('click', async (ev) => {
    const btn = ev?.currentTarget || null
    const ok = confirm(
      '清理浏览器缓存？\n\n'
      + '只删 Cache / Code Cache / 着色器缓存这些浏览器能自动重生成的目录。\n'
      + 'Cookies 和 Local Storage 保留，已经登录的 AI 站不会被踢下线。',
    )
    if (!ok) return
    const el = $('cache-result')
    el.className = 'result'
    el.textContent = '清理中…'
    if (btn && btn.dataset) btn.disabled = true
    try {
      const r = await api.clearCache()
      const skipped = r.skipped?.length ? `，${r.skipped.length} 项正被浏览器占用（下次自动补上）` : ''
      el.textContent = `已释放 ${fmtBytes(r.removedBytes)}（${r.removedItems} 项）${skipped}`
      el.className = 'result ok'
      await loadCacheStats()
    }
    catch (e) {
      el.textContent = `清理失败：${String(e?.message || e)}`
      el.className = 'result err'
    }
    finally {
      if (btn && btn.dataset) btn.disabled = false
    }
  })
}

init()
