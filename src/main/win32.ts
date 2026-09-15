/**
 * Win32 窗口操作封装（通过 koffi 直接调用 user32 / ntdll，无需编译原生模块）
 * 用途：把真实浏览器窗口作为子窗口嵌入到 Electron 主窗口的分格里。
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const koffi = require('koffi')

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const kernel32 = koffi.load('kernel32.dll')
const ntdll = koffi.load('ntdll.dll')

const HANDLE = 'uint64'
const HWND = 'uint64'
const BOOL = 'int'
const INT = 'int'
const LONG = 'int32'
const UINT = 'uint32'
const INT64 = 'int64'

const SetParent = user32.func('SetParent', HANDLE, [HWND, HWND])
const SetWindowLongPtrW = user32.func('SetWindowLongPtrW', INT64, [HWND, INT, INT64])
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', INT64, [HWND, INT])
const SetWindowPos = user32.func('SetWindowPos', BOOL, [HWND, HWND, INT, INT, INT, INT, UINT])
const MoveWindow = user32.func('MoveWindow', BOOL, [HWND, INT, INT, INT, INT, BOOL])
// 注意：koffi 的结构体对象出参不会写回，这里用 Buffer（uint8 *）接收 RECT
const GetWindowRect = user32.func('GetWindowRect', BOOL, [HWND, 'uint8 *'])
const GetClientRect = user32.func('GetClientRect', BOOL, [HWND, 'uint8 *'])
const ClientToScreen = user32.func('ClientToScreen', BOOL, [HWND, 'uint8 *'])
const IsWindow = user32.func('IsWindow', BOOL, [HWND])
const IsWindowVisible = user32.func('IsWindowVisible', BOOL, [HWND])
const ShowWindow = user32.func('ShowWindow', BOOL, [HWND, INT])
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', UINT, [HWND, 'uint32 *'])
const SetForegroundWindow = user32.func('SetForegroundWindow', BOOL, [HWND])
const SetFocus = user32.func('SetFocus', HANDLE, [HWND])
const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(uint64 hwnd, uint64 lparam)')
const EnumWindowsProcPtr = koffi.pointer(EnumWindowsProc)
const EnumWindows = user32.func('EnumWindows', BOOL, [EnumWindowsProcPtr, 'uint64'])
const EnumChildWindows = user32.func('EnumChildWindows', BOOL, [HWND, EnumWindowsProcPtr, 'uint64'])
const GetClassNameW = user32.func('GetClassNameW', INT, [HWND, 'char16 *', INT])
const GetWindowTextW = user32.func('GetWindowTextW', INT, [HWND, 'char16 *', INT])
const GetParent = user32.func('GetParent', HANDLE, [HWND])
const PostMessageW = user32.func('PostMessageW', BOOL, [HWND, UINT, 'uint64', 'int64'])
// Z 序查询（判断面板之上有没有自己的浏览器窗口，见 instance-manager 的 enforceZOrder）
const GetWindow = user32.func('GetWindow', HWND, [HWND, UINT])
const GetTopWindow = user32.func('GetTopWindow', HWND, [HWND])

/** WM_CLOSE：请求窗口正常关闭（浏览器会走完整的退出流程，档案才不会被写脏） */
export const WM_CLOSE = 0x0010

const OpenProcess = kernel32.func('OpenProcess', HANDLE, [UINT, BOOL, 'uint32'])
const CloseHandle = kernel32.func('CloseHandle', BOOL, [HANDLE])

// 窗口区域裁剪：用来把浏览器自带的标签栏/地址栏从可视区裁掉
const CreateRectRgn = gdi32.func('CreateRectRgn', HANDLE, [INT, INT, INT, INT])
const CreateRoundRectRgn = gdi32.func('CreateRoundRectRgn', HANDLE, [INT, INT, INT, INT, INT, INT])
const CombineRgn = gdi32.func('CombineRgn', INT, [HANDLE, HANDLE, HANDLE, INT])
const SetWindowRgn = user32.func('SetWindowRgn', BOOL, [HWND, HANDLE, BOOL])
const GetWindowRgn = user32.func('GetWindowRgn', INT, [HWND, HANDLE])
const GetRgnBox = gdi32.func('GetRgnBox', INT, [HANDLE, 'uint8 *'])
const DeleteObject = gdi32.func('DeleteObject', BOOL, [HANDLE])

/** CombineRgn 模式 */
export const RGN_AND = 1
export const RGN_OR = 2
export const RGN_XOR = 3
export const RGN_DIFF = 4
export const RGN_COPY = 5

const NtSuspendProcess = ntdll.func('NtSuspendProcess', 'int32', [HANDLE])
const NtResumeProcess = ntdll.func('NtResumeProcess', 'int32', [HANDLE])

export const GWL_STYLE = -16
export const GWL_EXSTYLE = -20
export const GWLP_HWNDPARENT = -8

export const WS_CHILD = 0x40000000
export const WS_POPUP = 0x80000000
export const WS_VISIBLE = 0x10000000
export const WS_CAPTION = 0x00c00000
export const WS_THICKFRAME = 0x00040000
export const WS_MINIMIZEBOX = 0x00020000
export const WS_MAXIMIZEBOX = 0x00010000
export const WS_SYSMENU = 0x00080000
export const WS_CLIPSIBLINGS = 0x04000000
export const WS_CLIPCHILDREN = 0x02000000
export const WS_EX_APPWINDOW = 0x00040000
export const WS_EX_TOOLWINDOW = 0x00000080

export const SWP_NOSIZE = 0x0001
export const SWP_NOMOVE = 0x0002
export const SWP_NOZORDER = 0x0004
export const SWP_NOACTIVATE = 0x0010
export const SWP_FRAMECHANGED = 0x0020
export const SWP_SHOWWINDOW = 0x0040
export const SWP_NOSENDCHANGING = 0x0400
export const SWP_ASYNCWINDOWPOS = 0x4000

export const HWND_TOPMOST = 0xffffffffffffffffn
export const HWND_NOTOPMOST = 0xfffffffffffffffen

export const SW_HIDE = 0
export const SW_SHOW = 5
export const SW_SHOWNORMAL = 1
export const SW_MAXIMIZE = 3

const PROCESS_ALL_ACCESS = 0x001f0fff

export function isWindow(hwnd: number | bigint): boolean {
  try {
    return !!IsWindow(hwnd)
  }
  catch {
    return false
  }
}

export function isWindowVisible(hwnd: number | bigint): boolean {
  try {
    return !!IsWindowVisible(hwnd)
  }
  catch {
    return false
  }
}

export function setParent(child: number | bigint, parent: number | bigint): number {
  return Number(SetParent(child, parent))
}

export function getParent(hwnd: number | bigint): number {
  return Number(GetParent(hwnd))
}

/**
 * 把浏览器窗口标记成工具窗口：不进任务栏、不出现在 Alt+Tab。
 *
 * 注意：WS_EX_TOOLWINDOW 在窗口可见时改动**不会自动重算窗口的显示属性**，
 * 老办法是先隐藏再设置。但 Electron 的 transparent 窗口是在 `show()` 那一刻
 * 才补上 WS_EX_LAYERED 的，会把先前加的 TOOLWINDOW 一起冲掉——所以有些场合
 * 只能在窗口已经可见之后再补，此时必须带 `refresh` 让系统重新套用一次样式。
 */
export function makeToolWindow(hwnd: number | bigint, refresh = false) {
  try {
    let ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
    ex = (ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, BigInt(ex))
    if (refresh) {
      SetWindowPos(
        hwnd,
        0,
        0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
      )
    }
  }
  catch (e) {
    console.warn('[win32] makeToolWindow failed', e)
  }
}

/**
 * 摘掉浏览器窗口的"标题栏位 + 可调整边框"，让 DWM 不再给这扇窗画框架。
 *
 * 为什么必须摘：Win11 的原生窗口框架（那一圈 1px 外框线 + 右上角的 ✕）和系统背板一样，
 * 是 **DWM 在合成阶段单独绘制的一层，不受 `SetWindowRgn` 约束**。分格里的浏览器外壳本来
 * 是要整块裁掉的，偏偏这圈框线和那个 ✕ 照旧画在窗口矩形的边上；2 格 / 4 格布局里它们
 * 正好落在相邻分格上，就是用户看到的「一条横线和一个 ✕ 入侵到上面那格」
 * （2026-09-15 查实，0.4.10 关掉背板后剩下的就是这个）。
 *
 * 实测数据（`scripts/verify-clip-pixels.js` 的像素统计；采样带 761×92，
 * 指标 = 带子顶部 4 行的"中性色像素"数，框线/按钮是中性色，棋盘格不是）：
 *   基线（样式 0x16cf0000）        ：1543
 *   只去 WS_THICKFRAME             ：1543  ← **一点没变**，它不是元凶
 *   只去 WS_SYSMENU                ： 856
 *   只去 WS_CAPTION                ： 851
 *   **CAPTION + THICKFRAME 都去**  ：  59  ← 只剩棋盘格自己的抗锯齿噪声
 *   再等 5 秒 / 再点一下激活分格    ：  59  ← Chrome 不会把它改回来
 *   还原样式                       ：1543  ← 完全可逆
 * 所以摘掉这两位就够了；SYSMENU / MIN / MAX 留着不碍事（实测与"全去"同值 59）。
 *
 * ⚠️ 唯一的副作用是好事：摘掉边框后窗口的外壳厚度会跟着变小
 *    （实测 {8,96,7,7} → {6,96,7,6}），`verifyGeometry` 的第 ① 项会发现并重新定位。
 *
 * 返回 true 表示这次真的改了（本来就没这两位时不重复写，省掉一次 FRAMECHANGED 重排）。
 */
export function stripWindowFrame(hwnd: number | bigint) {
  try {
    const style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE))
    const want = (style & ~(WS_CAPTION | WS_THICKFRAME)) >>> 0
    if (want === (style >>> 0)) return false
    SetWindowLongPtrW(hwnd, GWL_STYLE, BigInt(want))
    SetWindowPos(hwnd, 0, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
    return true
  }
  catch (e) {
    console.warn('[win32] stripWindowFrame failed', e)
    return false
  }
}

/** 窗口样式里是否还留着会被 DWM 画成框架的位（看门狗据此核对） */
export function windowHasFrame(hwnd: number | bigint): boolean {
  try {
    return (Number(GetWindowLongPtrW(hwnd, GWL_STYLE)) & (WS_CAPTION | WS_THICKFRAME)) !== 0
  }
  catch {
    return false
  }
}

/** 把浏览器窗口改成子窗口样式（仅用于嵌入验证脚本） */
export function makeChildWindow(hwnd: number | bigint) {
  try {
    let style = Number(GetWindowLongPtrW(hwnd, GWL_STYLE))
    style &= ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU)
    style |= WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN
    SetWindowLongPtrW(hwnd, GWL_STYLE, BigInt(style))

    let ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
    ex &= ~WS_EX_APPWINDOW
    ex |= WS_EX_TOOLWINDOW
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, BigInt(ex))
  }
  catch (e) {
    console.warn('[win32] makeChildWindow failed', e)
  }
}

export function getWindowLong(hwnd: number | bigint, index: number): number {
  try {
    return Number(GetWindowLongPtrW(hwnd, index))
  }
  catch {
    return 0
  }
}

/**
 * 设置窗口的属主（对顶级窗口即 owner）。属主窗口关闭时属主关系自动解除。
 *
 * ⚠️ 读回来的坑：实测在本应用里对**原生浏览器窗口**调用 `GetParent()`
 *    得到的是 0，即使窗口确实被本应用接管（位置/区域/置顶都生效）。
 *    所以**不要用 GetParent 判断"这个窗口是不是我们的"**——
 *    自检脚本请改用 `windowRegionBox() != null`（只有我们设过 SetWindowRgn）。
 *    确实需要读属主时用 `GetWindow(hwnd, GW_OWNER)`。
 */
export function setOwner(hwnd: number | bigint, owner: number | bigint) {
  try {
    SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, BigInt(owner))
  }
  catch (e) {
    console.warn('[win32] setOwner failed', e)
  }
}

/* ---------------- Z 序 ---------------- */

/** GetWindow 的 uCmd 取值 */
export const GW_HWNDFIRST = 0
export const GW_HWNDLAST = 1
export const GW_HWNDNEXT = 2
export const GW_HWNDPREV = 3

/**
 * 取 Z 序里紧邻的窗口。`GW_HWNDNEXT` 往屏幕里侧走一格（更靠下层）。
 * 用途：判断"面板之上还有没有自己的浏览器窗口"，好决定要不要重排。
 */
export function getWindow(hwnd: number | bigint, cmd: number): number {
  try {
    return Number(GetWindow(hwnd, cmd)) || 0
  }
  catch {
    return 0
  }
}

/** Z 序最顶层的窗口（含置顶带） */
export function getTopWindow(): number {
  try {
    return Number(GetTopWindow(0)) || 0
  }
  catch {
    return 0
  }
}

/**
 * 只改 Z 序：把 `hwnd` 插到 `insertAfter` 的**下一层**。
 *
 * 置顶带里的相对次序不会自己保持——用户一激活某个浏览器窗口，系统就把它提到
 * 带顶，面板立刻被压下去（顶栏又被浏览器标题栏盖住，白条复发）。所以每轮都要
 * 主动把浏览器窗口按回面板下方。
 */
export function placeBelow(hwnd: number | bigint, insertAfter: number | bigint): boolean {
  try {
    return !!SetWindowPos(hwnd, insertAfter, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
  }
  catch {
    return false
  }
}

/** 置顶 / 取消置顶 */
export function setTopMost(hwnd: number | bigint, on: boolean) {
  try {
    SetWindowPos(hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
  }
  catch {}
}

/** 把窗口提到同层级窗口的最前面（不激活） */
export function raiseWindow(hwnd: number | bigint, topMost: boolean) {
  try {
    SetWindowPos(hwnd, topMost ? HWND_TOPMOST : 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
  }
  catch {}
}

/**
 * 移动并调整窗口尺寸，但**不发送 WM_WINDOWPOSCHANGING**。
 *
 * 为什么必须跳过 WM_WINDOWPOSCHANGING：Chrome 标准窗口在处理这条消息时会把宽度
 * 钳制到 516px 以上（工具栏需要），导致窄分格下浏览器窗口溢出、遮挡相邻分格与面板按钮。
 * 跳过它即可让窗口缩到 270px 级别，同时 Chrome 仍会处理 WM_SIZE 正确重排页面。
 *
 * 为什么默认**同步**（不带 SWP_ASYNCWINDOWPOS）：
 *   实测跨进程 SetWindowPos 若同时带上 ASYNC + NOSENDCHANGING，
 *   请求会被投递到 Chrome UI 线程后**被丢弃**——窗口几何完全不变，
 *   而随后的 SetWindowRegion 却按新几何生效，于是出现
 *   "窗口还是 1000×760、页面 viewport 却已变成 536×1008" 的错位。
 *   改成同步调用后几何立即生效（代价是几毫秒阻塞），校准闭环才收敛。
 */
export function moveWindowNoClamp(hwnd: number | bigint, x: number, y: number, w: number, h: number, async = false) {
  try {
    const flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING | (async ? SWP_ASYNCWINDOWPOS : 0)
    const ok = SetWindowPos(
      hwnd,
      0,
      Math.round(x),
      Math.round(y),
      Math.max(1, Math.round(w)),
      Math.max(1, Math.round(h)),
      flags,
    )
    return !!ok
  }
  catch (e) {
    console.warn('[win32] moveWindowNoClamp failed', e)
    return false
  }
}

export function moveWindow(hwnd: number | bigint, x: number, y: number, w: number, h: number) {
  try {
    // hWndInsertAfter=0(HWND_TOP)：保证子窗口绘制在宿主内容之上
    SetWindowPos(
      hwnd,
      0,
      Math.round(x),
      Math.round(y),
      Math.max(1, Math.round(w)),
      Math.max(1, Math.round(h)),
      SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
    )
  }
  catch (e) {
    console.warn('[win32] moveWindow failed', e)
  }
}

export function showWindow(hwnd: number | bigint, cmd = SW_SHOW) {
  try {
    ShowWindow(hwnd, cmd)
  }
  catch {}
}

/**
 * 把窗口裁剪成一条圆角矩形（窗口自身坐标系，物理像素）。
 *
 * 用途：标准浏览器窗口自带标签栏 + 地址栏（实测约 150px 高）。
 * 嵌入分格后若只是把窗口整体上移，这块浏览器 UI 会盖住面板顶栏，
 * 导致顶栏按钮看不见也点不到；用窗口区域把它彻底裁掉，
 * 被裁掉的区域既不绘制也不接收鼠标，面板 UI 恢复正常。
 *
 * 传 null 表示恢复完整窗口。
 */
export function setWindowRegion(hwnd: number | bigint, rect: { x: number; y: number; width: number; height: number } | null, radius = 0) {
  setWindowRegionRects(hwnd, rect ? [rect] : [], radius)
}

/**
 * 更通用的版本：可视区域 = rects[0] 减去 rects[1..n]。
 *
 * 用途：分格底部展开 AI 切换器时，不必把整个浏览器窗口藏起来，
 * 只需要把下拉菜单那一小块从可视区域里**挖掉**，
 * 页面其余部分依然可见可点，观感接近"下拉浮在网页之上"。
 * （原生窗口无法与 Electron 内容做层叠，这是最接近原生的做法。）
 */
export function setWindowRegionRects(hwnd: number | bigint, rects: Array<{ x: number; y: number; width: number; height: number }>, radius = 0) {
  try {
    const list = (rects || []).filter((r) => r && r.width >= 1 && r.height >= 1)
    if (!list.length) {
      SetWindowRgn(hwnd, 0, 1)
      return
    }
    const rad = Math.max(0, Math.round(radius))
    const make = (r: { x: number; y: number; width: number; height: number }) => {
      const x = Math.round(r.x)
      const y = Math.round(r.y)
      const rr = Math.round(r.x + r.width)
      const b = Math.round(r.y + r.height)
      return rad > 0 ? CreateRoundRectRgn(x, y, rr + 1, b + 1, rad * 2, rad * 2) : CreateRectRgn(x, y, rr, b)
    }
    const dest = make(list[0])
    if (!dest) return
    for (let i = 1; i < list.length; i++) {
      const hole = make(list[i])
      if (!hole) continue
      // 原地求差集：CombineRgn 允许 hrgnDst 与 hrgnSrc1 相同
      CombineRgn(dest, dest, hole, RGN_DIFF)
      DeleteObject(hole)
    }
    // SetWindowRgn 成功后该 region 归系统所有，不能再 DeleteObject
    const ok = SetWindowRgn(hwnd, dest, 1)
    if (!ok) {
      try {
        DeleteObject(dest)
      }
      catch {}
    }
  }
  catch (e) {
    console.warn('[win32] setWindowRegionRects failed', e)
  }
}

/**
 * 判断窗口自身坐标系中的某个点是否落在窗口可视区域内。
 *
 * 因为"挖洞"后的区域是个复合区域，GetRgnBox 只能拿到外接矩形、看不出洞，
 * 所以自检时必须用 PtInRegion 逐点判断。
 */
export function pointInWindowRegion(hwnd: number | bigint, x: number, y: number): boolean | null {
  try {
    const rgn = CreateRectRgn(0, 0, 0, 0)
    if (!rgn) return null
    const kind = GetWindowRgn(hwnd, rgn)
    if (!kind) {
      DeleteObject(rgn)
      return true // 没有设置区域 = 整个窗口都可见
    }
    const PtInRegion = gdi32.func('PtInRegion', BOOL, [HANDLE, INT, INT])
    const hit = !!PtInRegion(rgn, Math.round(x), Math.round(y))
    DeleteObject(rgn)
    return hit
  }
  catch {
    return null
  }
}

/** 读取当前窗口区域的外接矩形（用于自检） */
export function windowRegionBox(hwnd: number | bigint) {  try {
    const rgn = CreateRectRgn(0, 0, 0, 0)
    if (!rgn) return null
    const kind = GetWindowRgn(hwnd, rgn)
    if (!kind) {
      DeleteObject(rgn)
      return null
    }
    const buf = Buffer.alloc(16)
    // GetRgnBox 与 GetWindowRect 一样属于结构体出参，用 Buffer 接收
    GetRgnBox(rgn, buf)
    DeleteObject(rgn)
    return {
      left: buf.readInt32LE(0),
      top: buf.readInt32LE(4),
      right: buf.readInt32LE(8),
      bottom: buf.readInt32LE(12),
    }
  }
  catch {
    return null
  }
}

/* ---------------- DWM 系统背板（Win11 那截"裁不掉的浏览器外壳"的元凶） ---------------- */

/**
 * Win11 会给窗口铺一层由 **DWM 自己绘制**的"系统背板"（Mica / Acrylic / Tabbed），
 * 它是独立于窗口内容的一层，**不受 `SetWindowRgn` 约束**。
 *
 * 后果（2026-09-15 查实的现网 bug）：浏览器标准窗口自带约 96px 的标题栏+标签栏+地址栏，
 * 我们靠 `SetWindowRgn` 把它从可视区裁掉——**Chrome 自己的内容确实被裁掉了**，可背板
 * 那一层照旧铺满整窗。于是那一截在外观上变成一条**死板纯色**（跟着壁纸变：浅色壁纸下
 * 是奶白色 `#F9F1EB`，另一个时刻是 `#F3F3F3`），并且照样盖在邻居上面。
 *
 * 为什么常年查不出来：`GetWindowRgn` / `PtInRegion` 读回来一切正常（区域确实设上了，
 * 命中测试也确实生效），所有基于区域的自检都判"通过"。**只有采屏幕像素才看得见**。
 * 这也解释了为什么它只在 Win11 复现：Win10 没有系统背板这一层。
 *
 * 关掉它的代价约等于零：这层只在"窗口可见"时有意义，而分格里的浏览器外壳本来就要被裁掉。
 */
const dwmapi = (() => {
  try {
    return koffi.load('dwmapi.dll')
  }
  catch (e) {
    console.warn('[win32] dwmapi.dll 加载失败，系统背板只能听天由命', e)
    return null
  }
})()
const DwmSetWindowAttribute = dwmapi?.func('DwmSetWindowAttribute', 'int32', [HWND, UINT, 'uint8 *', UINT]) ?? null
const DwmGetWindowAttribute = dwmapi?.func('DwmGetWindowAttribute', 'int32', [HWND, UINT, 'uint8 *', UINT]) ?? null

/**
 * `DWMWA_SYSTEMBACKDROP_TYPE`：Win11 22H2（build 22621）起才有。
 * 老系统调用会返回 `E_INVALIDARG`，我们一律当"没有背板这回事"处理，什么都不做。
 */
const DWMWA_SYSTEMBACKDROP_TYPE = 38
/** 背板类型：0 让系统自己挑（Win11 上会挑 Mica），1 就是不要背板 */
export const DWMSBT_AUTO = 0
export const DWMSBT_NONE = 1

/** 读窗口当前的系统背板类型；读不到（Win10 / 老版本）返回 null */
export function windowBackdropType(hwnd: number | bigint): number | null {
  if (!DwmGetWindowAttribute) return null
  try {
    const buf = Buffer.alloc(4)
    if (DwmGetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, buf, 4) !== 0) return null
    return buf.readUInt32LE(0)
  }
  catch {
    return null
  }
}

/** 这个窗口是不是还挂着会铺满整窗的背板（拿不准时返回 false，宁可不折腾） */
export function windowBackdropIsPainted(hwnd: number | bigint): boolean {
  const t = windowBackdropType(hwnd)
  return t !== null && t !== DWMSBT_NONE
}

/**
 * 关掉窗口的系统背板。返回 true 表示这次确实调成功了。
 * Win10 上会返回 false —— 那边本来也没这层，属于正常情况，不要当失败刷日志。
 */
export function disableWindowBackdrop(hwnd: number | bigint): boolean {
  if (!DwmSetWindowAttribute) return false
  try {
    const buf = Buffer.alloc(4)
    buf.writeUInt32LE(DWMSBT_NONE, 0)
    return DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, buf, 4) === 0
  }
  catch {
    return false
  }
}

export function focusWindow(hwnd: number | bigint) {
  try {
    SetFocus(hwnd)
    SetForegroundWindow(hwnd)
  }
  catch {}
}

export function getWindowRect(hwnd: number | bigint) {
  try {
    const buf = Buffer.alloc(16)
    const ok = GetWindowRect(hwnd, buf)
    if (!ok) return null
    return {
      left: buf.readInt32LE(0),
      top: buf.readInt32LE(4),
      right: buf.readInt32LE(8),
      bottom: buf.readInt32LE(12),
    }
  }
  catch {
    return null
  }
}

export function getClassName(hwnd: number | bigint): string {
  try {
    const buf = Buffer.alloc(512)
    const n = GetClassNameW(hwnd, buf, 256)
    if (!n) return ''
    return buf.toString('utf16le', 0, n * 2)
  }
  catch {
    return ''
  }
}

export function windowSize(hwnd: number | bigint): { width: number; height: number } {
  const r = getWindowRect(hwnd)
  if (!r) return { width: 0, height: 0 }
  return { width: r.right - r.left, height: r.bottom - r.top }
}

/**
 * 测量窗口边框内衬：窗口矩形与客户区之间的差值。
 * 标准浏览器窗口（带标题栏/边框）在嵌入分格时，需要用它把**客户区**对齐到分格矩形，
 * 否则分格边缘会露出浏览器边框。
 */
export function windowFrameInsets(hwnd: number | bigint): {
  left: number
  top: number
  right: number
  bottom: number
  frameWidth: number
  frameHeight: number
  clientWidth: number
  clientHeight: number
} | null {
  try {
    const wr = Buffer.alloc(16)
    if (!GetWindowRect(hwnd, wr)) return null
    const cr = Buffer.alloc(16)
    if (!GetClientRect(hwnd, cr)) return null
    const pt = Buffer.alloc(8)
    pt.writeInt32LE(0, 0)
    pt.writeInt32LE(0, 4)
    if (!ClientToScreen(hwnd, pt)) return null

    const wx = wr.readInt32LE(0)
    const wy = wr.readInt32LE(4)
    const ww = wr.readInt32LE(8) - wx
    const wh = wr.readInt32LE(12) - wy
    const cx = pt.readInt32LE(0)
    const cy = pt.readInt32LE(4)
    const cw = cr.readInt32LE(8) - cr.readInt32LE(0)
    const ch = cr.readInt32LE(12) - cr.readInt32LE(4)

    return {
      left: cx - wx,
      top: cy - wy,
      right: wx + ww - (cx + cw),
      bottom: wy + wh - (cy + ch),
      frameWidth: ww,
      frameHeight: wh,
      clientWidth: cw,
      clientHeight: ch,
    }
  }
  catch {
    return null
  }
}

/** 按窗口类名查找顶层窗口（后创建的优先，返回第一个匹配） */
export function findWindowByClass(cls: string): number {
  let hit = 0
  let cb: any = null
  try {
    const koffiLocal = koffi
    cb = koffiLocal.register((hwnd: any) => {
      if (hit) return false
      if (getClassName(hwnd) === cls || getClassName(hwnd).startsWith(cls)) hit = Number(hwnd)
      return !hit
    }, EnumWindowsProcPtr)
    EnumWindows(cb, 0n)
  }
  catch (e) {
    console.warn('[win32] findWindowByClass failed', e)
  }
  finally {
    if (cb) {
      try {
        koffi.unregister(cb)
      }
      catch {}
    }
  }
  return hit
}

/**
 * 查找浏览器主窗口。
 *
 * 注意：Chrome / Edge 进程里存在多个 `Chrome_WidgetWin_*` 窗口，
 * 其中 `Chrome_WidgetWin_0` 是尺寸很大的**隐藏辅助窗口**，
 * 只有 `Chrome_WidgetWin_1` 才是真正显示网页的主窗口。
 * 早期按"面积最大"挑选会误选辅助窗口，导致后续 MoveWindow 全部作用在不可见窗口上。
 */
export function findBrowserWindowByPid(pid: number): number | null {
  const hwnds = findWindowsByPid(pid)
  const sized = hwnds
    .map((h) => ({ h, cls: getClassName(h), size: windowSize(h), visible: isWindowVisible(h) }))
    .filter((c) => c.size.width > 200 && c.size.height > 150)

  // 首选：真正的主窗口类名（Chrome_WidgetWin_1）
  const main = sized
    .filter((c) => c.cls === 'Chrome_WidgetWin_1' && c.visible)
    .sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height)
  if (main.length) return main[0].h

  // 次选：其它可见的顶层浏览器窗口
  const others = sized
    .filter((c) => c.cls.startsWith('Chrome_WidgetWin') && c.visible)
    .sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height)
  if (others.length) return others[0].h

  // 兜底：任何可见窗口
  const anyVisible = sized.filter((c) => c.visible).sort((a, b) => b.size.width * b.size.height - a.size.width * a.size.height)
  return anyVisible[0]?.h ?? null
}

/** 枚举某进程的所有顶层窗口 */
export function findWindowsByPid(pid: number): number[] {
  const found: number[] = []
  let cb: any = null
  try {
    cb = koffi.register((hwnd: any) => {
      try {
        const out = new Uint32Array(1)
        GetWindowThreadProcessId(hwnd, out)
        if (Number(out[0]) === pid) found.push(Number(hwnd))
      }
      catch {}
      return true
    }, EnumWindowsProcPtr)
    EnumWindows(cb, 0n)
  }
  catch (e) {
    console.warn('[win32] EnumWindows failed', e)
  }
  finally {
    if (cb) {
      try {
        koffi.unregister(cb)
      }
      catch {}
    }
  }
  return found
}

/** 进程休眠 / 唤醒（Windows 没有 SIGSTOP，用 NtSuspendProcess） */
export function suspendProcess(pid: number): boolean {
  try {
    const h = Number(OpenProcess(PROCESS_ALL_ACCESS, 0, pid))
    if (!h) return false
    const r = NtSuspendProcess(h)
    CloseHandle(h)
    return r >= 0
  }
  catch {
    return false
  }
}

export function resumeProcess(pid: number): boolean {
  try {
    const h = Number(OpenProcess(PROCESS_ALL_ACCESS, 0, pid))
    if (!h) return false
    const r = NtResumeProcess(h)
    CloseHandle(h)
    return r >= 0
  }
  catch {
    return false
  }
}

export function getWindowText(hwnd: number | bigint): string {
  try {
    const buf = Buffer.alloc(2048)
    const n = GetWindowTextW(hwnd, buf, 1024)
    if (!n) return ''
    return buf.toString('utf16le', 0, n * 2)
  }
  catch {
    return ''
  }
}

export function getWindowPid(hwnd: number | bigint): number {
  try {
    const out = new Uint32Array(1)
    GetWindowThreadProcessId(hwnd, out)
    return Number(out[0])
  }
  catch {
    return 0
  }
}

/** 请求窗口正常关闭（不是强杀）。浏览器接到后会正常退出并落盘档案。 */
export function postClose(hwnd: number | bigint) {
  try {
    PostMessageW(hwnd, WM_CLOSE, 0n, 0n)
  }
  catch {}
}

/**
 * 在窗口的所有后代里按类名找子窗口，返回**可见且面积最大**的那个。
 *
 * 用途：Chromium 把网页内容渲染在一个独立的子窗口 `Chrome_RenderWidgetHostHWND` 里，
 * 它的矩形（相对主窗口）= 网页 viewport，于是不需要 CDP 就能量出
 * "浏览器自身 UI（标题栏 + 标签栏 + 地址栏）占了多少高度"。
 * 一个窗口里每个标签页都有一个这样的子窗口，但只有当前标签页那个是可见的。
 */
export function findChildByClass(parent: number | bigint, cls: string): number {
  let best = 0
  let bestArea = 0
  let cb: any = null
  try {
    cb = koffi.register((hwnd: any) => {
      const h = Number(hwnd)
      if (getClassName(h) !== cls) return true
      if (!isWindowVisible(h)) return true
      const r = getWindowRect(h)
      if (!r) return true
      const area = (r.right - r.left) * (r.bottom - r.top)
      if (area > bestArea) {
        bestArea = area
        best = h
      }
      return true
    }, EnumWindowsProcPtr)
    EnumChildWindows(parent, cb, 0n)
  }
  catch (e) {
    console.warn('[win32] findChildByClass failed', e)
  }
  finally {
    if (cb) {
      try {
        koffi.unregister(cb)
      }
      catch {}
    }
  }
  return best
}

/** Chromium 网页内容窗口类名（Chrome / Edge 通用） */
export const CHROME_RENDER_WIDGET_CLASS = 'Chrome_RenderWidgetHostHWND'

/**
 * 量出网页内容区相对窗口左上角的偏移与内衬（物理像素）。
 *
 * 返回 null 表示拿不到（例如目标不是 Chromium 浏览器窗口）。
 * 实测（Chrome 150 / 100% DPI / 标准窗口）：{ left: 8, top: 87, right: 8, bottom: 8 }，
 * 且**与窗口尺寸无关**——所以定位一次即可，不需要任何迭代校准。
 */
export function chromeContentInsets(hwnd: number | bigint): { left: number, top: number, right: number, bottom: number } | null {
  try {
    const wr = getWindowRect(hwnd)
    if (!wr) return null
    const child = findChildByClass(hwnd, CHROME_RENDER_WIDGET_CLASS)
    if (!child) return null
    const cr = getWindowRect(child)
    if (!cr) return null
    const ww = wr.right - wr.left
    const wh = wr.bottom - wr.top
    return {
      left: cr.left - wr.left,
      top: cr.top - wr.top,
      right: (wr.left + ww) - cr.right,
      bottom: (wr.top + wh) - cr.bottom,
    }
  }
  catch {
    return null
  }
}

export interface BrowserWindowInfo {
  hwnd: number
  pid: number
  title: string
  rect: { x: number, y: number, width: number, height: number }
}

/**
 * 列出桌面上所有"真正装着网页"的浏览器顶层窗口。
 *
 * 为什么不能只按类名挑：Chrome 的**对话框**（例如"无法更新 Chrome"）同样叫
 * `Chrome_WidgetWin_1`，按类名 + 尺寸挑会挑错，把后续所有窗口操作都作用在对话框上。
 * 可靠的判据是**它里面有没有 `Chrome_RenderWidgetHostHWND`**——
 * 只有承载网页的窗口才有。
 *
 * 尺寸下限刻意放到 200×150（而不是 400×300）：
 * 窄分格里的浏览器窗口只有 270px 宽，阈值定高了就认不出自己的窗口。
 * 靠"必须有网页内容"这一条已经足够排除对话框与气泡。
 */
export function listBrowserWindows(): BrowserWindowInfo[] {
  const out: BrowserWindowInfo[] = []
  let cb: any = null
  try {
    const cands: number[] = []
    cb = koffi.register((hwnd: any) => {
      const h = Number(hwnd)
      if (getClassName(h) !== 'Chrome_WidgetWin_1') return true
      if (!isWindowVisible(h)) return true
      const r = getWindowRect(h)
      if (!r) return true
      if (r.right - r.left < 200 || r.bottom - r.top < 150) return true
      cands.push(h)
      return true
    }, EnumWindowsProcPtr)
    EnumWindows(cb, 0n)
    koffi.unregister(cb)
    cb = null

    for (const h of cands) {
      if (!findChildByClass(h, CHROME_RENDER_WIDGET_CLASS)) continue
      const r = getWindowRect(h)
      if (!r) continue
      out.push({
        hwnd: h,
        pid: getWindowPid(h),
        title: getWindowText(h),
        rect: { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top },
      })
    }
  }
  catch (e) {
    console.warn('[win32] listBrowserWindows failed', e)
  }
  finally {
    if (cb) {
      try {
        koffi.unregister(cb)
      }
      catch {}
    }
  }
  return out
}

export function parseHwnd(buf: Buffer | Uint8Array): number {
  if (!buf) return 0
  if (buf.length === 8) return Number(Buffer.from(buf).readBigUInt64LE(0))
  if (buf.length === 4) return Number(Buffer.from(buf).readUInt32LE(0))
  return Number(Buffer.from(buf).readBigUInt64LE(0))
}

/* ---------------- 前台窗口变化（事件驱动） ---------------- */

/**
 * `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`：前台窗口一变就立刻回调。
 *
 * 为什么非它不可：点任意一个分格里的浏览器窗口，系统都会把它提到置顶带的顶端 ——
 * 也就是**浮到面板之上**。而那个窗口是完整的 Chrome 窗口，除了网页内容还有顶上
 * 一截标签栏 / 工具栏（平时被我们的 `SetWindowRgn` 从可视区裁掉），一旦翻到面板上面：
 *   · 第一行分格（1 / 2 格布局）那一截正好落在顶栏 → 顶栏"闪一下白"；
 *   · 第二行分格（4 格布局的 3 / 4）落在上一格的底部 → 那块既不画网页也不画面板，
 *     看上去就是一块透明区域。
 * 以前只有 200ms 轮询的 Z 序看门狗在兜，那半帧人眼看得见。
 *
 * 它是 **out-of-context** 钩子：不需要 DLL 注入，回调投递到安装线程自己的消息队列，
 * 由那个线程的消息泵取出 —— Electron 主进程正好有一条，所以在主线程安装即可。
 * 万一装不上，轮询看门狗还在，只是延迟回到 200ms（不会出现错误行为）。
 */
const WinEventProc = koffi.proto('void WinEventProc(uint64 hook, uint32 event, uint64 hwnd, int32 idObject, int32 idChild, uint32 eventThread, uint32 eventTime)')
const WinEventProcPtr = koffi.pointer(WinEventProc)
const SetWinEventHook = user32.func('SetWinEventHook', HANDLE, ['uint32', 'uint32', HANDLE, WinEventProcPtr, 'uint32', 'uint32', 'uint32'])
const UnhookWinEvent = user32.func('UnhookWinEvent', BOOL, [HANDLE])
const GetForegroundWindow = user32.func('GetForegroundWindow', HWND, [])

export const EVENT_SYSTEM_FOREGROUND = 0x0003
/** out-of-context（回调投递到本线程消息队列，不需要注入 DLL） */
const WINEVENT_OUTOFCONTEXT = 0x0000
/** 跳过本进程产生的事件：面板 / 设置窗口自己抢前台不必打扰我们 */
const WINEVENT_SKIPOWNPROCESS = 0x0002

const foregroundSubs = new Set<(hwnd: number) => void>()
/** koffi 的回调必须长期持有引用：对象被 GC 掉之后原来的函数指针就悬了 */
let winEventCbPointer: unknown = null
let foregroundHookHandle: number | bigint | null = null

/** 当前前台窗口（拿不到就是 0） */
export function foregroundWindow(): number {
  try {
    return Number(GetForegroundWindow()) || 0
  }
  catch {
    return 0
  }
}

/** 订阅前台变化；返回退订函数 */
export function watchForeground(fn: (hwnd: number) => void): () => void {
  foregroundSubs.add(fn)
  void installForegroundHook()
  return () => {
    foregroundSubs.delete(fn)
    // 最后一个订阅者退订就把钩子一并卸掉，别让系统继续朝一个没人听的回调投递事件
    if (foregroundSubs.size === 0) unwatchForegroundAll()
  }
}

function installForegroundHook() {
  if (foregroundHookHandle) return
  try {
    winEventCbPointer = koffi.register((_hook: unknown, _event: unknown, hwnd: unknown, idObject: unknown, idChild: unknown, _thread: unknown, _ts: unknown) => {
      // 只认窗口级的事件：OBJID_WINDOW(0) 且没有子对象
      if (Number(idObject) !== 0 || Number(idChild) !== 0) return
      const h = Number(hwnd) || 0
      if (!h) return
      if (process.env.AIQUAD_DEBUG_HOOK) console.log(`[win32] fg -> ${h}`)
      for (const fn of Array.from(foregroundSubs)) {
        try {
          fn(h)
        }
        catch (e) {
          console.warn('[win32] 前台变化回调出错', e)
        }
      }
    }, WinEventProcPtr)
    const handle = SetWinEventHook(
      EVENT_SYSTEM_FOREGROUND,
      EVENT_SYSTEM_FOREGROUND,
      0,
      winEventCbPointer,
      0,
      0,
      WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
    )
    if (handle) {
      foregroundHookHandle = handle
      if (process.env.AIQUAD_DEBUG_HOOK) console.log('[win32] 前台钩子已挂载')
    }
    else console.warn('[win32] SetWinEventHook 未安装成功，层级维持仍依赖轮询看门狗')
  }
  catch (e) {
    console.warn('[win32] SetWinEventHook 失败，层级维持仍依赖轮询看门狗', e)
  }
}

/** 卸载前台钩子（正常退出时调用；进程要结束时不调用也无所谓） */
export function unwatchForegroundAll() {
  if (foregroundHookHandle) {
    try {
      UnhookWinEvent(foregroundHookHandle)
    }
    catch {}
    foregroundHookHandle = null
  }
  foregroundSubs.clear()
}
