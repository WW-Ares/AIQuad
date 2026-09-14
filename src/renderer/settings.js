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
    if ($('sc-status').className !== 'sc-status err') return
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
  // 面板必须置顶才能压住浏览器窗口（顶栏、悬浮胶囊都画在面板上），恒为 true
  $('opt-ontop').checked = true
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

  if (info?.browser) {
    $('browser-info').textContent = `当前：${info.browser.name} ${info.browser.version || ''}`
  }
  else {
    $('browser-info').textContent = '未检测到 Chrome / Edge，请安装或指定路径'
  }
  const sp = cfg.proxy.systemServer
  $('system-proxy').textContent = sp ? `已检测到：${sp}（类型 ${cfg.proxy.systemType || 'http'}）` : '未检测到系统代理'

  $('about').innerHTML = `版本 ${info?.version || '-'}<br>用户数据：${info?.userData || '-'}<br>浏览器档案：${info?.profiles || '-'}`

  renderAiRows()
}

function renderAiRows() {
  const tbody = $('ai-rows')
  tbody.innerHTML = ''
  for (const ai of cfg.aiList) {
    const tr = document.createElement('tr')

    const tdName = document.createElement('td')
    const inName = document.createElement('input')
    inName.value = ai.name
    inName.addEventListener('change', () => {
      ai.name = inName.value
    })
    tdName.appendChild(inName)

    const tdUrl = document.createElement('td')
    const inUrl = document.createElement('input')
    inUrl.value = ai.url
    inUrl.addEventListener('change', () => {
      ai.url = inUrl.value
    })
    tdUrl.appendChild(inUrl)

    const tdCat = document.createElement('td')
    const cat = document.createElement('select')
    for (const [v, t] of [['us', '国外 AI'], ['cn', '国内 AI']]) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = t
      if ((ai.category || 'cn') === v) o.selected = true
      cat.appendChild(o)
    }
    cat.addEventListener('change', () => {
      ai.category = cat.value
    })
    tdCat.appendChild(cat)

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
      ai.proxyMode = sel.value
      if (ai.proxyMode === 'custom' && !ai.proxy) {
        ai.proxy = { mode: 'custom', type: 'http', host: '', port: '', bypassList: '' }
      }
      renderAiRows()
    })
    tdProxy.appendChild(sel)

    const tdOp = document.createElement('td')
    const del = document.createElement('button')
    del.textContent = '删除'
    del.className = 'btn-danger'
    del.addEventListener('click', async () => {
      cfg.aiList = cfg.aiList.filter((a) => a.id !== ai.id)
      await save(false)
      renderAiRows()
    })
    tdOp.appendChild(del)

    tr.append(tdName, tdUrl, tdCat, tdProxy, tdOp)
    tbody.appendChild(tr)

    if (ai.proxyMode === 'custom') {
      const tr2 = document.createElement('tr')
      const td = document.createElement('td')
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
        ai.proxy.type = sel2.value
      })
      const host = document.createElement('input')
      host.placeholder = '127.0.0.1'
      host.style.width = '140px'
      host.value = ai.proxy?.host || ''
      host.addEventListener('change', () => {
        ai.proxy.host = host.value
      })
      const port = document.createElement('input')
      port.placeholder = '端口'
      port.style.width = '90px'
      port.value = ai.proxy?.port || ''
      port.addEventListener('change', () => {
        ai.proxy.port = port.value
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
  // 恒为 true：面板压不住浏览器窗口的话顶栏就会被浏览器的标题栏盖掉
  cfg.alwaysOnTop = true
  cfg.autoStart = $('opt-autostart').checked
  cfg.hibernateBackground = $('opt-hibernate').checked
  return cfg
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
      setTimeout(() => {
        r.textContent = ''
      }, 2500)
    }
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

  // 快捷键抓取控件必须在 fill() 之前初始化，否则 fill() 设的值会被覆盖
  if (window.ShortcutCapture) ShortcutCapture.init(document)
  fill()

  $('btn-save').addEventListener('click', () => save(true))

  // 抓取到一个组合后：先本地校验（重复/缺修饰键），再问主进程（是否被占用），
  // 都过了才自动保存，让用户当场就能按下去试。
  for (const f of SC_FIELDS) {
    const el = document.getElementById(f.id)
    if (!el) continue
    el.addEventListener('change', async () => {
      const ok = await validateShortcuts()
      if (ok) await save(false)
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

  $('btn-test-proxy').addEventListener('click', async () => {
    const el = $('proxy-result')
    el.textContent = '测试中…'
    el.className = 'result'
    const p = collect().proxy
    const url = cfg.aiList[0]?.url || 'https://www.google.com'
    const r = await api.testProxy(p, url)
    el.textContent = r.ok ? `通过（${r.ms}ms）` : `失败：${r.error || '超时'}`
    el.className = r.ok ? 'result ok' : 'result err'
  })

  $('btn-open-profiles').addEventListener('click', () => api.openPath(info.profiles))

  // 位置 / 宽度比例改动后立即预览效果
  for (const r of document.querySelectorAll('input[name="position"]')) {
    r.addEventListener('change', () => save(false))
  }
  // 滑块：拖动时只更新数字，松手（change）才真正保存，避免拖动过程中反复重启实例
  const ratio = document.getElementById('ratio')
  if (ratio) {
    ratio.addEventListener('input', () => {
      $('ratio-val').textContent = `${ratio.value}%`
    })
    ratio.addEventListener('change', () => save(false))
  }
}

init()
