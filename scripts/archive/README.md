# 归档：探索期的验证脚本

这里的脚本是定位问题时的一次性探针，结论已经写进 `README.md` 与主流程代码，
**不再是当前架构的有效验证入口**，保留只为留痕。

注意：它们的 `require('../dist/...')` 相对路径是放在 `scripts/` 下的，移到这里后需要改成 `../../dist/...` 才能跑。

## 各脚本留下的结论

| 脚本 | 当时的用途 | 结论 |
|---|---|---|
| `diag-input.js` / `diag-input2.js` / `diag-attach.js` | 验证 SetParent 子窗口嵌入后键盘为何失效 | `AttachThreadInput` / `SetFocus` 都救不回 → **放弃 SetParent，改顶级窗口** |
| `diag-ctrl.js` | 测试 SendInput 注入键盘 | 顶级窗口后键盘本来就正常，无需注入 |
| `diag-pane.js` / `diag-pane2.js` | 测 Chrome 标准窗口最小宽度 | 默认 ≥516px，`SWP_NOSENDCHANGING` 可绕过 |
| `diag-top.js` | 工具栏遮挡顶栏 | 结论：应裁剪而非整体上移 |
| `diag-lag.js` | 怀疑异步 `SetWindowPos` 被丢弃 | 实为校准闭环"盲加增量"雪崩；后改为按子窗口实测，不再需要校准 |
| `diag-minsize.js` / `diag-owner.js` | 最小尺寸、owner 关系实验 | 结论已进 `win32.ts` 注释 |
| `embed-test.js` | SetParent 嵌入可行性 | 已被顶级窗口方案取代 |
| `probe-gpu.js` / `probe-ui.js` | Electron 起不来（GPU 进程崩溃） | 需要 `--no-sandbox`，见 README「受限环境」 |
| `e2e-instance.js` / `verify-final.js` | v0.3 的端到端验证 | 用的是已被移除的 `setHostWindow` / `uiHeight` 接口，由 `scripts/verify-shared.js` 取代 |
