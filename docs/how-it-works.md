# AIQuad 实现原理

> 这份文档面向**想了解实现细节、或打算改代码**的人。
> 软件怎么用、有哪些功能，见 [README](../README.md)。

## 目录

- [整体架构](#整体架构)
- [为什么是"共享会话"（v0.3 → v0.4 的关键改动）](#为什么是共享会话v03--v04-的关键改动)
- [为什么是"顶级窗口"而不是 SetParent 子窗口（v0.2 → v0.3 的关键改动）](#为什么是顶级窗口而不是-setparent-子窗口v02--v03-的关键改动)
- [面板与分格的坐标系](#面板与分格的坐标系)
- [站点侧：为什么不会被判定为"应用内嵌浏览器"](#站点侧为什么不会被判定为应用内嵌浏览器)
- [验证结果（本机实测）](#验证结果本机实测)

## 整体架构

```
主壳（Electron：面板窗口 / 顶栏 / 分格网格 / 设置）
        │  启动并管理
        ▼
一个真实 Chrome / Edge 进程（**共享会话**）
  └─ 每个分格 = 这个进程里的一个窗口
     --user-data-dir=<共用档案> --profile-directory=Default \
     --remote-debugging-port=0 --new-window <AI网址> --window-size=1000,760
     [--proxy-server=...] --disable-blink-features=AutomationControlled --test-type
        │  Win32：SWP_NOSENDCHANGING 落位 + SetWindowRgn 裁剪 + owner 归属
        ▼
浏览器窗口以"顶级窗口 + 属主=面板"的形式精确覆在分格内容区上
```

## 为什么是"共享会话"（v0.3 → v0.4 的关键改动）

v0.3 给每个分格开了**独立档案**，结果是同一个 Gemini 在 2 格要登录两次。
Chrome 的档案（Cookie / localStorage / 登录态）天然是**进程级单例**：

> 同一个 `--user-data-dir` 第二次启动时，新进程会把命令行交给**已在运行的实例**
> 再开一个窗口，然后自己退出（实测子进程 85ms 后以 code 0 退出）。

利用这个机制，v0.4 让所有分格共用一份档案，于是"任意分格登录、其它分格继承"自然成立
（`--new-window` 正是"已有实例再开一个窗口"的开关）。
代价是**代理变成进程级设置**：共享会话下只能走全局代理；要按 AI 分代理，
在设置页关掉「登录态共享」即可（每个分格一套独立档案 + 独立进程）。

## 为什么是"顶级窗口"而不是 SetParent 子窗口（v0.2 → v0.3 的关键改动）

v0.2 用 `SetParent` 把浏览器窗口变成面板的子窗口。看起来最直接，但有一个致命问题：

> **跨进程 reparent 之后，Windows 的系统焦点仍留在宿主线程上，
> 键盘事件无法路由到嵌入的浏览器窗口。"能点，但打不了字"，
> 中文输入法更是完全不可用。**

实测 `AttachThreadInput`、`SetFocus` 都救不回来（见 `scripts/diag-input.js` / `diag-attach.js`）。

v0.3 起改为**顶级窗口 + 属主关系**，并把"看起来像嵌进去"这件事交给四个 Win32 技巧：

| 技巧 | 解决的问题 |
|---|---|
| `SWP_NOSENDCHANGING` | 跳过 `WM_WINDOWPOSCHANGING`，绕过 Chrome 标准窗口 **≥516px 的最小宽度钳制**，271px 的窄格也能精确落位 |
| `SetWindowRgn` | 把浏览器自带的标题栏/标签栏/地址栏从可视区裁掉。被裁掉的区域**既不绘制也不接收鼠标**，面板顶栏按钮因此完全正常 |
| `WS_EX_TOOLWINDOW` | 浏览器窗口不进任务栏、不出现在 Alt+Tab |
| `GWLP_HWNDPARENT`（owner） | 浏览器窗口永远浮在面板之上，且随手最小化/隐藏 |

补充要点：

1. **标准浏览器窗口**（不是 `--app` 应用窗口）→ `display-mode` 保持 `browser`，
   与用户手动双击浏览器打开完全一致，Google 登录不会判定为"应用内嵌浏览器"；
2. **怎么把窗口精确对齐到分格：不靠估算，也不靠 CDP。**
   Chromium 把网页渲染在一个独立子窗口 `Chrome_RenderWidgetHostHWND` 里，
   它的矩形**就是 viewport**。实测它相对主窗口恒为 `(8, 87)`，且与窗口尺寸无关
   （271×700 与 1000×760 下偏移相同），于是：
   ```
   窗口尺寸 = 分格尺寸 + (left+right, top+bottom)
   窗口位置 = 分格屏幕坐标 − (left, top)
   裁剪区域 = { x: left, y: top, 宽: 分格宽, 高: 分格高 }
   ```
   实测 **viewport 与分格矩形逐像素相等（误差 0px）**，且这条路径**完全不需要 CDP**
   ——v0.3 里"只有第一个分格被裁掉、其余分格露出工具栏"的 bug 正是
   "工具栏高度只能靠 CDP 量，CDP 挂了就退化成 0"造成的；
3. **挑浏览器主窗口不能只按类名**：Chrome 的对话框（如"无法更新 Chrome"）同样叫
   `Chrome_WidgetWin_1`，按类名 + 面积挑会挑到对话框上。
   可靠判据是**它里面有没有 `Chrome_RenderWidgetHostHWND`**——只有承载网页的窗口才有；
4. **认出新开的窗口靠"差分"**：启动前记下桌面上的浏览器窗口集合，
   启动后多出来的那个就是本格的。共享会话下新窗口属于**已在运行的进程**，
   刚 spawn 的子进程只是把命令行交出去就退了，按 PID 找窗口根本对不上；
5. **指纹开关要成对用**：只要开了调试端口，`navigator.webdriver` 就是 `true`，
   必须加 `--disable-blink-features=AutomationControlled` 关掉；
   但单独加它又会招来 Chrome 的"您使用的是不受支持的命令行标记"黄色警示条
   （实测把内容区从 87px 压到 143px），所以必须同时加 `--test-type` 豁免这条警告。
   实测组合：不加 = `webdriver: true`；只加前者 = `false` 但有警示条；**两者都加 = `false` 且干净**；
6. 启动前会预置档案首选项（`translate.enabled=false`、`has_seen_welcome_page=true`、
   `exit_type=Normal`）并补上 `First Run` 哨兵：
   否则英文站点会弹出**独立的"翻译此页？"原生气泡**浮在分格上，
   被强杀过的档案还会在下次启动弹"恢复页面"；
7. 展开 AI 下拉时，只把**菜单那一小块矩形**从浏览器窗口的可视区域里"挖掉"
   （`CombineRgn` + `RGN_DIFF`），页面其余部分照旧可见——
   原生窗口无法与 Electron 内容做层叠，这是最接近原生浮层的做法。

## 面板与分格的坐标系

面板窗口是"整块画布"，分格内容区由渲染层用 `getBoundingClientRect()` 量出来交给主进程
（`pane-rects` IPC）。每个分格在底部预留 `PANE_FOOTER = 46px` 画 AI 切换器
（原生浏览器窗口盖在上面，不预留就会被整个遮住），所以：

```
浏览器窗口可视区 = 分格矩形 − 底部 46px
窗口整体尺寸     = 可视区 + 工具栏高度 + 边框内衬
窗口位置         = 面板屏幕坐标 + 分格相对偏移 − 边框内衬
```

## 站点侧：为什么不会被判定为"应用内嵌浏览器"

早期版本使用 `--app` 应用窗口模式，会出现"此浏览器或应用可能不安全"。

**根因（实测定位）**：`--app` 模式会让页面明确知道自己不是普通浏览器窗口——
这是 Google 风控判定"应用内嵌浏览器"的直接依据：

| 检测项 | `--app` 应用窗口 | 标准浏览器窗口 |
|---|---|---|
| `matchMedia('(display-mode: standalone)')` | **true** | false |
| `matchMedia('(display-mode: browser)')` | false | **true** |
| 浏览器 UI 高度（`outerHeight - innerHeight`） | 39px（无工具栏） | 95~151px（完整工具栏） |

同时相关排查结论：站点侧可见的 HTTP 头（`sec-ch-ua` 等）与 JS 指纹
（`navigator.webdriver`、`window.chrome`、WebAuthn 可用性）在真实浏览器下本就正常，
**不是请求头或常规指纹问题**；而对照项目 `rtugeek/ai` 在内嵌 webview 上还额外
硬编码了一个与内核版本不符的 UA（`Chrome/136 Edg/136`），那是它必然被拦的另一原因。

**修复**：改用标准浏览器窗口 + 工具栏裁剪（见上文）。设置页里仍保留"窗口形态"
可切换回应用窗口，若某些站点在标准窗口下反而异常时可对比验证。

可用如下脚本自行复核这些指标（无需 Electron）：

```bash
node scripts/verify-clip.js    # display-mode / 工具栏高度 / 裁剪后 viewport 精度
node scripts/e2e-instance.js   # 端到端：真实实例 + 宿主窗口 + 对齐校验
node scripts/diag-display.js   # 两种窗口形态的 display-mode 对比
```

## 验证结果（本机实测）

环境：Chrome 150 / 1920×1080 / DPI 96。

`node scripts/verify-shared.js` —— **17 项全通过**（直接驱动生产代码里的 `InstanceManager`）：

| 项目 | 结果 |
|---|---|
| 4 个分格是否同一浏览器进程 | ✅ 进程数 = 1（登录态共享的前提） |
| viewport 与分格矩形对齐 | ✅ 四格 278×470 / 282×470 / 278×478 / 282×478 **逐像素相等** |
| 每格工具栏是否被裁掉 | ✅ 四格 insets 全部实测为 `{8, 87, 8, 8}`，可见区 == 分格矩形 |
| **登录态共享** | ✅ p1 写下的 Cookie，p2 **立即可见**（同一份浏览器档案） |
| `navigator.webdriver` | ✅ `false`（且无"不受支持的命令行标记"警示条） |
| 多余原生窗口 | ✅ 只有 4 个分格窗口，无翻译气泡 / 推广弹窗 / "无法更新"对话框 |
| 退出是否干净 | ✅ `shutdownAll` 后 0 残留窗口（WM_CLOSE 优雅退出，Cookie 落盘） |

`SHARED=0 node scripts/verify-shared.js` 覆盖另一种模式（每格独立档案 + 独立进程，此时代理可按 AI 分设）。

`node scripts/verify-shortcut-capture.js` —— **27 项全通过**（往真实设置窗口注入真实按键事件）：

| 项目 | 结果 |
|---|---|
| 四个输入框 readonly 且被抓取控件接管 | ✅ 手打不进去，只能抓取 |
| 聚焦进入录制态 | ✅ 显示"按下快捷键…"、状态行提示录制中 |
| 抓取 `Ctrl+Alt+K` | ✅ 自动抓取并落盘到 `config.json` |
| 乱序组合 `Alt+Ctrl+7` | ✅ 规范化成 `Ctrl+Alt+7` |
| `Esc` / `Backspace` | ✅ 取消保留原值 / 清空且**真的写进配置**（不再被静默还原成默认值） |
| 裸字母（Shift+字母 / 单个键） | ✅ 拒绝并说明原因（会全局抢走打字键） |
| `F9` 单用 | ✅ 允许（F1–F24 与媒体键是例外） |
| 查重 | ✅ 冲突的两项一起标红 |
| 占用探测 | ✅ 自己注册的键**不**误报；`Super+L` 这类系统保留组合正确报 `taken` |

其他回归：`verify-shared` 17/17、`verify-recovery` 6/6、`verify-settings` 9/9。

界面层面的实测结论：

- **打包版整屏实拍**：直接跑 `build/win-unpacked/AIQuad.exe`，不带任何降级环境变量，
  靠应用自身的启动自愈起来；四格 ChatGPT / Gemini / Claude / DeepSeek 对齐误差均为 0px；
- **快捷键录制态**：呼出快捷键停在"按下快捷键…"，分格切换三个字段分别是正常 / 正常 / 未设置，
  底部状态行显示录制提示；
- **下拉浮层**：展开 AI 切换器时页面其余部分保持可见，只有菜单那一小块矩形被从浏览器窗口可视区"挖掉"；
- **三种布局**：1 / 2 / 4 格的顶栏按钮、底部切换器与分格铺排均正常。

## 已知坑（改代码前先看）

- **升级 Chrome 后启动即弹框 `Error: spawn ENOENT`**：Chrome 从用户级安装
  （`%LOCALAPPDATA%\Google\Chrome\Application`）迁到系统级（`%ProgramFiles%\...`），原路径被删。
  `spawn` 的失败是通过 ChildProcess 的 `'error'` **事件**上报的，没监听器就是未捕获异常，
  Electron 于是弹出"A JavaScript error occurred in the main process"。
  修复分三层：探测段逐条候选**验真**（`Application\exe` → `Application\<版本>\exe` → 注册表 `App Paths`）；
  启动段 spawn 前校验路径、失效则重新探测重试一次、`'error'` 转 promise rejection；
  兜底段挂 `uncaughtException` / `unhandledRejection` 日志。兜底路径也验证过：分格状态变 `failed`
  并给出可读原因，**不崩**。
- **设置改了没反应（所有设置项一起失效）**：`settings.js` 的 `collect()` 读了一个 HTML 中
  不存在的 `#opt-shared`，`null.checked` 抛 TypeError 打断整个 `collect()` ——
  保存时任何一项都不生效、界面还无报错。已改为防御式取元素（缺元素只影响该项并打 warn）
  + 保存包 try/catch + 界面显示失败原因；「面板宽度」由固定档位改成 20%~60% 滑块
  （原配置里 0.42 这类非档位值会一个都不选中，保存时被静默重置回 30%）。
- **升级 Chrome 后又弹"选择账号登录"**：首启引导的"已看过"标记**不只在** `Default/Preferences`，
  还有一部分在档案根目录 `Local State` 里且**带版本号**——Chrome 一升版本（实测 150 → 153），
  缺了这些标记就会重新弹引导 / 档案选择器。现在 `prepareProfile` 会**同时**落定 `Local State`：
  `profile.picker_shown / last_used / profiles_order`、`browser.has_seen_welcome_page /
  first_run_finished`、`distribution.skip_first_run_ui`。实测对已存在的老档案也会补写，
  且不影响其中已登录的账号。
- **单实例锁残留**：残留一个宿主进程就会占着 `%APPDATA%\aiquad` 的**单实例锁**，
  此后每次启动都走到 `requestSingleInstanceLock() === false` → 立刻 `app.quit()`：
  **没有窗口、日志干净、退出码 0**，看起来就像"双击没反应"，极难联想到是残留进程。
  所以**验证脚本必须走 `scripts/lib/process-cleanup.js` 的 `cleanupRun` 真正结束被测应用**；
  排查手段是 `scripts/probe-singleton.js`（实测就是这么抓到 4 个残留 `AIQuad.exe` 的）。
- **受限环境（容器 / 虚拟机 / 远程桌面）**：Chromium 无法创建 GPU 进程时
  报 `GPU process isn't usable. Goodbye.` 之后整个应用直接退出，用户视角是"双击了没反应"。
  已自动化：应用会把「上一次启动是否活着走到窗口出现」记在
  `%APPDATA%/aiquad/startup-state.json`，上次没起来就自动降级为软件渲染 + 关进程沙箱，
  并且**粘住**（否则会陷入"崩一次、好一次"的循环）。手动开关 `AIQUAD_DISABLE_GPU=1` /
  `AIQUAD_NO_SANDBOX=1` / `AIQUAD_FORCE_GPU=1`（反向解除"粘住"）。
  实测：仅 `--disable-gpu` 在进程沙箱本身受限的环境里依然失败，必须加上 `--no-sandbox` 才能起来。

## 自检脚本

大部分不需要 Electron，可直接 `node` 跑：

```bash
node scripts/verify-shared.js            # 共享会话 / 裁剪 / 对齐 / Cookie 继承，17 项断言（驱动生产代码）
SHARED=0 node scripts/verify-shared.js   # 同上，但走"每格独立档案"模式
node scripts/verify-recovery.js          # 浏览器升级搬走安装目录后的启动自愈（含"彻底找不到"的报错路径）
node scripts/verify-settings.js          # 设置页端到端：真实打开设置窗口 → 跑 collect()/save() → 回读 config.json
node scripts/verify-shortcut-capture.js  # 快捷键抓取：往真实设置窗口注入真实按键事件，27 项断言
node scripts/shot-packaged.js 45         # 【交付验收】启动打包版 AIQuad.exe，整屏截图 + 逐格核对对齐
node scripts/shot-desktop.js 32          # 同上，但跑源码版（node_modules/electron）
node scripts/ui-check.js                 # 启动真实应用，核对顶栏按钮/底部切换器/1-2-4 布局，并逐布局截图
node scripts/verify-dropdown.js          # 验证下拉"挖洞"：页面保持可见 + 菜单位置真的被裁开
node scripts/smoke.js                    # 探测浏览器 → 启动实例 → CDP → 窗口定位
node scripts/diag-headers.js             # 对比不同启动模式下站点可见的请求头与指纹
```

排障用（诊断窗口 / 启动路径，不是常规回归）：

```bash
node scripts/probe-panel-origin.js   # 把主进程所有顶层窗口摊开，定位"面板客户区原点"
node scripts/probe-singleton.js      # 枚举桌面上所有顶层窗口（含不可见），排查"谁占着单实例锁"
node scripts/log-packaged.js 30      # 采集打包版 stdout（末尾加 gpu 则不降级，用于复现 GPU 崩溃）
node scripts/log-dev.js 18 gpu       # 同上，跑源码版；再加 force 验证 AIQUAD_FORCE_GPU 能解除降级
```

旧版一次性诊断脚本已归档到 `scripts/archive/`（含各自的结论）。
`smoke.js` 会打印 `navigator.webdriver = false`，这是不触发站点风控的关键指标。

---

返回 [README](../README.md)
