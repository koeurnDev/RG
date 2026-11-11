# 应用内更新 Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans to implement the scoped tasks below. Keep unrelated download/NTFS behavior unchanged.

**Goal:** 正式版在应用内下载新版，显示进度，并在用户点击后重启安装；保留现有用户数据。

**Architecture:** 沿用现有 GitHub 正式版本检测和更新提示，用 electron-updater 执行已打包应用的下载、校验与安装。固定官方仓库，不接受渲染进程传入地址。Mac 发布最终签名公证应用的 ZIP 和更新元数据；Windows 增加 NSIS 安装包并保留便携包。

**Tech Stack:** Electron 44、React 18、electron-builder 26.15.3、electron-updater 6.8.9。

## Global Constraints

- 用户已确认正式版 1.80，配置 1.80.0。
- 用户已允许 30–60 分钟及外部排队所需的必要发行验证。
- 不修改 Issue #25 涉及的下载逻辑，不自动关闭或回复 Issue #26。
- 不自动退出安装，不因正常退出而安装；下载/合并/转码忙碌时拒绝重启。
- Mac arm64、x64 与 Windows x64 同版本；Windows 无代码签名证书必须披露。
- 旧版首次升级仍需原有方式安装；新能力从本版开始生效。

## Task 1: 下载与安装控制

Files: `src/native/app-update-installer.js`, `main.js`, `preload.js`, `scripts/check-app-update-installer.cjs`, `scripts/check-app-update.cjs`.

- [x] 先用可控 updater 事件写失败测试：新版确认、重复请求合并、下载进度、校验失败、关闭更新、忙碌时禁止安装、显式重启。
- [x] 控制器提供 `download(expectedVersion)`, `install()`, `cancel()`, `getState()`；状态通过 `app-update-state` 推送。
- [x] IPC 提供 `download-app-update`, `install-app-update`, `get-app-update-state`，保留现有检查/打开发布页接口作为回退。
- [x] 使用固定 GitHub feed，关闭自动下载和退出时自动安装；用户点击后才执行。
- [x] 验证相关 IPC 和状态行为，不触及正式资料或真实安装。

## Task 2: 更新界面

Files: `src/components/AppUpdateNotice.jsx`, `src/components/AppUpdateNotice.css`, `src/components/Settings.jsx`, `scripts/check-app-update-ui.cjs`.

- [x] 沿用现有主题和按钮，先验证完整状态流程。
- [x] 新版提示提供“下载更新”，显示进度；完成后提供“重启并安装”。错误可重试，关闭提醒不自动安装。
- [x] Windows 便携版和开发环境提供准确的手动更新回退；设置中增加再次打开检查入口。
- [x] 验证关闭提示、重新检查、禁用检查及失败重试，完成受影响界面检查。

## Task 3: 正式发行

Files: `package.json`, `package-lock.json`, `.github/workflows/windows.yml`, release documentation.

- [ ] 确认版本后统一版本、文档和下载入口。
- [ ] Windows NSIS 安装包与对应元数据必须保留相同 ASCII 名称；仍提供原便携 EXE/ZIP。
- [ ] Mac 更新 ZIP 必须由最终签名、公证、装订后的 App 生成，重新计算 SHA512/size，合并双架构元数据。
- [ ] 发布前核对源码、隐私、签名、公证、更新元数据和对应源码包；分别记录实机与模拟验证边界。
- [ ] 发布后回读版本与附件，检查下载完整性；只有证据满足才声明已发布。
