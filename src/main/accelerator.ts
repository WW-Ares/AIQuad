/**
 * Electron 加速键（accelerator）的解析、校验与规范化。
 *
 * 为什么需要它：
 *   `globalShortcut.register()` 有两种失败方式，旧代码把它们都吞掉了——
 *     · 加速键**语法非法** → 抛异常 → 被 try/catch 吃掉，只留一行 console.warn
 *     · 加速键**被别的程序占用** → 返回 false → 连 catch 都不进，返回值直接丢掉
 *   两种情况下用户在设置页都看不到任何反馈，只有"按下去没反应"。
 *   所以这里先把语法判死（能给出明确原因），再把注册结果回传给界面。
 *
 * 另外，抓取控件产出的字符串会经过这里规范化，所以大小写（`ctrl+alt+k`）、
 * 顺序（`Alt+Ctrl+K`）不同也都能正常工作，手改 config.json 同样受益。
 */

const ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'] as const

/** 修饰键别名 → 规范名。CommandOrControl 在 Windows 上就是 Ctrl */
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  ctl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  win: 'Super',
  cmd: 'Super',
  command: 'Super',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
}

/** 具名键（小写 → Electron 规范写法） */
const NAMED_KEYS: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  capslock: 'Capslock',
  numlock: 'Numlock',
  scrolllock: 'Scrolllock',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  return: 'Return',
  enter: 'Return',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  esc: 'Escape',
  plus: 'Plus',
  printscreen: 'PrintScreen',
  pause: 'Pause',
  volumeup: 'VolumeUp',
  volumedown: 'VolumeDown',
  volumemute: 'VolumeMute',
  medianexttrack: 'MediaNextTrack',
  mediaprevioustrack: 'MediaPreviousTrack',
  mediastop: 'MediaStop',
  mediaplaypause: 'MediaPlayPause',
  numadd: 'numadd',
  numsub: 'numsub',
  nummult: 'nummult',
  numdiv: 'numdiv',
  numdec: 'numdec',
}

/** 允许作为按键的可见字符 */
const PUNCTUATION = new Set(['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/'])

/**
 * 可以**不带修饰键**单独使用的键。
 * 除此之外一律要求 Ctrl / Alt / Win 之一——尤其不能放行「Shift+字母」，
 * 那等于把全局打字键抢走，用户在别的程序里就再也打不出那个大写字母了。
 * 注意是"必须有强修饰键"，而不是"必须有修饰键"：Shift 本身不算。
 */
const MODIFIER_FREE = /^(F(?:[1-9]|1[0-9]|2[0-4])|PrintScreen|Pause|Volume(Up|Down|Mute)|Media(PlayPause|Stop|NextTrack|PreviousTrack))$/

/** 强修饰键：只有它们才能把普通按键变成全局快捷键 */
const STRONG_MODIFIERS = ['Ctrl', 'Alt', 'Super']

function canonicalKey(raw: string): string | null {
  const lower = raw.toLowerCase()
  if (NAMED_KEYS[lower]) return NAMED_KEYS[lower]
  // 单个字母：'a' → 'A'（注意 F 键一定带数字，所以 'f' 是字母 F，不是 F 键）
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase()
  if (/^[0-9]$/.test(lower)) return lower
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(lower)) return `F${lower.slice(1)}`
  if (/^num[0-9]$/.test(lower)) return lower
  if (PUNCTUATION.has(raw)) return raw
  return null
}

export interface ParsedAccelerator {
  /** 规范化后的加速键，可直接交给 globalShortcut */
  accelerator: string
  modifiers: string[]
  key: string
}

/** 解析失败返回 null（并**不**说明失败原因，原因由调用方按场景给出） */
export function parseAccelerator(input: unknown): ParsedAccelerator | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (!raw) return null

  const parts = raw.split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return null

  const key = canonicalKey(parts[parts.length - 1])
  if (!key) return null

  const modifiers: string[] = []
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIER_ALIASES[p.toLowerCase()]
    if (!m) return null
    if (!modifiers.includes(m)) modifiers.push(m)
  }
  const hasStrong = modifiers.some((m) => STRONG_MODIFIERS.includes(m))
  if (!hasStrong && !MODIFIER_FREE.test(key)) return null

  modifiers.sort((a, b) => ORDER.indexOf(a as any) - ORDER.indexOf(b as any))
  return { accelerator: [...modifiers, key].join('+'), modifiers, key }
}

/** 规范化；不可解析时返回 null */
export function normalizeAccelerator(input: unknown): string | null {
  return parseAccelerator(input)?.accelerator ?? null
}

export function isValidAccelerator(input: unknown): boolean {
  return parseAccelerator(input) !== null
}
