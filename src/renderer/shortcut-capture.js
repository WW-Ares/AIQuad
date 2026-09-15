/**
 * 快捷键「抓取」控件。
 *
 * 旧版是纯文本输入框：要用户自己手打 `Ctrl+Alt+1` 这种字符串，
 * 大小写、顺序、键名写法全靠猜；打错了 `globalShortcut.register` 只会静默失败，
 * 用户看到的就是"设了没反应"。
 *
 * 现在：点一下输入框 → 进入录制态 → 按下组合键自动抓取、自动规范化。
 *
 * 交互约定（与 VS Code / JetBrains 一致）：
 *   · 单击或聚焦输入框 → 开始录制（输入框显示"按下快捷键…"，边框高亮）
 *   · 按修饰键（Ctrl/Alt/Shift/Win）本身 → 不算捕获，继续等你按主键
 *   · Esc → 取消，保留原值
 *   · Backspace / Delete → 清除（空值 = 禁用该项，主进程会跳过注册）
 *   · 失焦 → 取消，保留原值
 *
 * 规则：必须带 Ctrl / Alt / Win 之一；F1–F24 与音量/媒体键可以单独用。
 * 不放行「Shift+字母」——那等于全局抢走打字键。
 *
 * 真值存在 `input.dataset.acc`，而不是 `input.value`：
 * 录制态下 `value` 显示的是提示文案，如果直接拿 `value` 当数据，
 * 用户录到一半去点保存就会把"按下快捷键…"存进配置。
 */
(function () {
  'use strict'

  const MODS = [
    ['ctrlKey', 'Ctrl'],
    ['altKey', 'Alt'],
    ['shiftKey', 'Shift'],
    ['metaKey', 'Super'],
  ]

  const MOD_CODES = new Set([
    'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
  ])

  /** KeyboardEvent.code → Electron 加速键名 */
  const NAMED_CODES = {
    Space: 'Space',
    Enter: 'Return',
    NumpadEnter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Escape',
    CapsLock: 'Capslock',
    NumLock: 'Numlock',
    ScrollLock: 'Scrolllock',
    PrintScreen: 'PrintScreen',
    Pause: 'Pause',
    VolumeUp: 'VolumeUp',
    VolumeDown: 'VolumeDown',
    VolumeMute: 'VolumeMute',
    AudioVolumeUp: 'VolumeUp',
    AudioVolumeDown: 'VolumeDown',
    AudioVolumeMute: 'VolumeMute',
    MediaPlayPause: 'MediaPlayPause',
    MediaStop: 'MediaStop',
    MediaTrackNext: 'MediaNextTrack',
    MediaTrackPrevious: 'MediaPreviousTrack',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadDecimal: 'numdec',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
  }

  const PLACEHOLDER = '按下快捷键…'
  const MODIFIER_FREE = /^(F(?:[1-9]|1[0-9]|2[0-4])|PrintScreen|Pause|Volume(Up|Down|Mute)|Media(PlayPause|Stop|NextTrack|PreviousTrack))$/

  function keyFromCode(code) {
    if (!code) return null
    if (NAMED_CODES[code]) return NAMED_CODES[code]
    let m = /^Key([A-Z])$/.exec(code)
    if (m) return m[1]
    m = /^Digit([0-9])$/.exec(code)
    if (m) return m[1]
    m = /^Numpad([0-9])$/.exec(code)
    if (m) return `num${m[1]}`
    m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
    if (m) return `F${m[1]}`
    return null
  }

  /**
   * 本地规范化：把 `alt+ctrl+k` 这类写法统一成 `Ctrl+Alt+K`，只用于**显示与查重**。
   * 认不出来的修饰键/主键一律判不合法，交给主进程的 parseAccelerator 给最终结论。
   */
  function normalize(acc) {
    const raw = String(acc || '').trim()
    if (!raw) return { ok: true, accelerator: '' }
    const parts = raw.split('+').map((p) => p.trim()).filter(Boolean)
    if (!parts.length) return { ok: false, reason: '空值' }

    const rawKey = parts[parts.length - 1]
    const key = keyFromCode(rawKey) || (/^[a-zA-Z0-9]$/.test(rawKey) ? rawKey.toUpperCase() : null)
    if (!key) return { ok: false, reason: `识别不了主键「${rawKey}」` }

    const mods = []
    for (const p of parts.slice(0, -1)) {
      const hit = MODS.find(([, n]) => n.toLowerCase() === p.toLowerCase())
      if (!hit) return { ok: false, reason: `识别不了修饰键「${p}」` }
      if (!mods.includes(hit[1])) mods.push(hit[1])
    }
    if (!mods.some((m) => m === 'Ctrl' || m === 'Alt' || m === 'Super') && !MODIFIER_FREE.test(key)) {
      return { ok: false, reason: '需要 Ctrl / Alt / Win 作修饰键（Shift 单独不算），或者单独用 F1–F24' }
    }
    mods.sort((a, b) => ['Ctrl', 'Alt', 'Shift', 'Super'].indexOf(a) - ['Ctrl', 'Alt', 'Shift', 'Super'].indexOf(b))
    return { ok: true, accelerator: [...mods, key].join('+') }
  }

  /** 当前录制中的控件（同一时刻只允许一个） */
  let active = null

  function attach(input, hooks) {
    const onState = (hooks && hooks.onState) || function () {}

    const setValue = (acc) => { input.dataset.acc = acc || '' }
    setValue(input.dataset.acc || '')

    function start() {
      if (active === input) return
      if (active) active.__stop(true)
      active = input
      input.__prev = input.dataset.acc || ''
      input.__recording = true
      input.classList.add('recording')
      input.value = PLACEHOLDER
      onState(input, 'rec', '')
    }

    input.__stop = function stop(restore) {
      if (!input.__recording) return
      input.__recording = false
      input.classList.remove('recording')
      if (restore) setValue(input.__prev)
      input.value = input.dataset.acc || ''
      if (active === input) active = null
      onState(input, 'idle', '')
    }

    function commit(acc) {
      setValue(acc)
      input.__stop(false)
      input.value = input.dataset.acc || ''
      // 让 settings.js 走和"手改输入框"一样的链路（校验 + 保存）
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.blur()
    }

    input.addEventListener('focus', start)
    input.addEventListener('click', () => { if (!input.__recording) start() })
    input.addEventListener('blur', () => { if (input.__recording) input.__stop(true) })

    input.addEventListener('keydown', (e) => {
      // 非录制态：readonly 已经拦住了输入，这里再兜一层
      if (!input.__recording) { e.preventDefault(); return }
      e.preventDefault()
      e.stopPropagation()

      const code = e.code || ''
      if (MOD_CODES.has(code)) return // 只按了修饰键：继续等主键

      const noMod = !e.ctrlKey && !e.altKey && !e.metaKey
      if (code === 'Escape' && noMod) { input.__stop(true); return }
      if ((code === 'Backspace' || code === 'Delete') && noMod) { commit(''); return }

      const key = keyFromCode(code)
      if (!key) {
        onState(input, 'bad', `识别不了这个键（code=${code || '未知'}），换个键试试`)
        return
      }
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !MODIFIER_FREE.test(key)) {
        onState(input, 'bad', '需要 Ctrl / Alt / Win 作修饰键（Shift 单独不算，否则会全局抢走打字），或者单独用 F1–F24')
        return
      }
      const parts = MODS.filter(([f]) => e[f]).map(([, n]) => n)
      commit([...parts, key].join('+'))
    })

    // 录制期间吞掉 keyup / keypress：否则 Ctrl+W、F5 这类会被页面或系统顺手执行掉
    for (const type of ['keyup', 'keypress']) {
      input.addEventListener(type, (e) => {
        if (!input.__recording) return
        e.preventDefault()
        e.stopPropagation()
      })
    }

    return {
      get: () => input.dataset.acc || '',
      set: (acc) => { setValue(acc); if (!input.__recording) input.value = input.dataset.acc || '' },
    }
  }

  const registry = new WeakMap()

  /**
   * @param root  作用域（默认 document）
   * @param hooks { onIdle } 录制结束（抓到键 / Esc 取消 / 失焦）后回调一次。
   *   ⚠️ 必须回调：这个控件自己只会在录制/报错时写状态栏，结束后不吱声的话，
   *   那句"录制中…"或红色警告就会**一直挂在页面上**——点 Esc 取消、按了不合规的键
   *   再放弃录制，都会留下一条过期提示。交给外面重新校验一遍才能给出当前真状态。
   */
  function init(root, hooks) {
    const scope = root || document
    const list = scope.querySelectorAll('.sc-input')
    for (const el of list) {
      if (registry.has(el)) continue
      registry.set(el, attach(el, {
        onState: (input, state, msg) => {
          input.classList.toggle('bad', state === 'bad')
          const status = document.getElementById('sc-status')
          if (!status) return
          if (state === 'bad') {
            status.className = 'sc-status err'
            status.textContent = msg
          }
          else if (state === 'rec') {
            status.className = 'sc-status warn'
            status.textContent = '录制中：按 Esc 取消，Backspace 清除'
          }
          else {
            // 录制结束：先把这个控件自己的提示收掉，再请外面重新校验四个框
            status.className = 'sc-status'
            status.textContent = ''
            hooks?.onIdle?.(input)
          }
        },
      }))
    }
    return list.length
  }

  function get(input) {
    if (!input) return ''
    const h = registry.get(input)
    return h ? h.get() : (input.dataset.acc || '')
  }

  function set(input, acc) {
    if (!input) return
    const h = registry.get(input)
    if (h) h.set(acc)
    else { input.dataset.acc = acc || ''; input.value = acc || '' }
  }

  window.ShortcutCapture = { init, get, set, normalize }
})()
