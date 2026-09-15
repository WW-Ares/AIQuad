# 发布说明的固定尾巴

这几段不随版本变化，所以**不在 CHANGELOG 里逐版重复**：`scripts/release-notes.js` 会把
[`CHANGELOG.md`](../CHANGELOG.md) 里该版本的正文拼在这份模板前面，一起交给
`gh release create --notes-file`。要改安装说明、已知限制或许可证文案，**只改这里**一处。

- `{{version}}` 会被替换成实际版本号。
- 分隔线 `---` 以上是给人看的说明，**以下才是要拼进发布页的正文**（脚本按第一条 `---` 切开）。

---

### 安装

下载下面的 `AIQuad-Setup-{{version}}.exe` 直接安装，适用于 **Windows 10 / 11**，覆盖安装即可，不用先卸载旧版（配置和登录态在 `%APPDATA%\aiquad`，会保留）。想要便携版就下 `AIQuad-Portable-{{version}}.exe`。

> ⚠️ **安装包没有做代码签名**，首次运行时 Windows SmartScreen 可能提示
> "Windows 已保护你的电脑"。点击「更多信息」→「仍要运行」即可。
> 源码完全公开，也可以自行构建：`npm install && npm run dist`。

### 已知限制

- 开启「登录态共享」时代理是**进程级**设置，只能全局；要按 AI 分别走代理请关闭该开关
- 浏览器窗口是独立的原生窗口，AI 下拉浮层靠在窗口上「挖洞」让位，浮层不能超出分格范围
- 分格宽度小于约 270px 时，部分站点（如 ChatGPT）会自行切到窄屏版式，属站点行为

功能与使用场景见 [README](https://github.com/WW-Ares/AIQuad#readme)；
实现原理、对齐算法与实测验证数据见
[docs/how-it-works.md](https://github.com/WW-Ares/AIQuad/blob/main/docs/how-it-works.md)。

### 许可证

[MIT](https://github.com/WW-Ares/AIQuad/blob/main/LICENSE) © 2026 WW-Ares 与 AI 协作
