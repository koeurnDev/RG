# 1.80 发行准备

版本：1.80.0；计划标签：v1.80。此文记录发行要求，不代表已构建、安装、签名、公证或发布。最终状态以发行验收记录为准。

## 本轮变化

- 安装版增加应用内下载更新与重启安装入口，并显示下载进度及错误。
- Mac 提供 Apple Silicon、Intel 两套 DMG 和更新 ZIP，共用 latest-mac.yml。
- Windows 增加 NSIS 安装版和 latest.yml，继续提供便携 EXE/ZIP；便携版通过下载页面更新。
- 更新源固定为项目官方 GitHub Release，下载后校验 SHA512；Windows 仍未签名，不具有 Authenticode 发布者验证保证。

## 发行资产

- 两个架构的最终签名、公证、装订 DMG。
- 两个架构的最终签名、公证、装订 App ZIP，以及只引用这些最终 ZIP 的 latest-mac.yml。
- hongguo-downloader-1.80.0-win-x64-setup.exe、对应 blockmap、latest.yml。
- hongguo-downloader-1.80.0-win-x64.exe 及包含同一便携 EXE 的 ZIP。
- 精确应用源码、各平台媒体工具对应源码、许可及 SHA256SUMS.txt。

## 必要验收

- 配置/锁文件版本一致；发布资产名称、更新清单版本、SHA512 和大小一致。
- Mac 两架构 App 与 DMG 的签名、公证和装订；更新 ZIP 解压后验证同一最终 App。
- Windows CI 原便携版媒体窗口检查，加上隔离 NSIS 安装、启动和同版本重装资料保留检查；输出 installer-result.json。
- 应用内检查、下载、进度、失败处理和重启安装流程；只有实际跨版本安装验证后才能声明端到端更新通过。
- 真实 Windows/GPU、Intel Mac 实机、干净 Gatekeeper 与长期覆盖仍按实际结果单独记录，不能用 CI 或 Rosetta 代替。

## 使用说明

1.75 及更早版本需要先从官方 Release 手动安装 1.80。1.80 的 Mac 应用和 Windows 安装版将通过应用内入口安装后续更高版本。Windows 便携版保留手动下载方式。

发布时先完成 Draft 全部资产验收，再统一转正式 latest，避免用户读到不完整更新清单。
