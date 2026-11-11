# 红果短剧 3.8

**状态：正式发布。** 内部版本 `3.8.0`，标签 `v3.8`，于 2026-10-26 发布。三端 16 项附件的远端 SHA256 与大小已核对；双 Mac App 与 DMG 完成 Developer ID 签名、Apple 公证 Accepted 和票据装订；Windows EXE 未签名。冻结源码 `528c716a085dc4e3323ebd0aec7fb96815bc6523`。

3.8 修复官网搜索搜不到当天新剧的问题。官网搜索索引没有同名结果、接口返回 502，或短剧名被更长的老剧名遮蔽时，应用会从 App 近 7 天上新目录补搜，并给补搜结果标记「今日上新」/「App 新剧」。

## 搜索当天新剧

- 官网搜索第一页没有标题匹配时，自动读取 App 真实短剧与 AI 短剧的近 7 天上新列表，按标题补搜。
- 4 字以内短剧名还会排除“老剧名包含新剧名”的遮蔽，例如搜「接班」只返回《接班人的考题》时，仍会补到当天的《接班》。
- 官网接口 5xx/结构变化时，App 上新列表能补到结果就直接显示，不再只报错或空等页面兜底。
- 补搜结果显示「今日上新」/「App 新剧」标记；官网已有精确同名结果时不额外请求 App。
- 补搜失败不影响官网结果；加载更多仍固定官网通道，不把补搜结果混进下一页。
- App 搜索实验开关仍默认关闭；本次补搜读取 App 分类目录，不需要开启该开关。
- 反向匹配（搜索词比剧名长）按标题命中排序；单字/纯标点搜索不触发补搜。

## 验证

- `npm run build:react` 通过。
- `npm test` 通过：全部单元测试与 87 项平台检查，包含新增的 App 上新补搜、排序、单字门槛和 502 救援检查。
- 真实网络：App 上新列表约 99 条（当天 43 条），冷请求 1.4–1.7 秒、缓存命中 0 毫秒；「西北往事之我与我家」官网无同名结果时补搜命中当天的《西北往事之我与我家第一季》；「接班」「别拿真心赌婚姻」官网已有精确结果时不触发补搜；3 个新 `series_id` 分别能拉到 43/20/67 集。
- 最终签名 arm64 包在隔离资料中真实下载《接班》两集（HEVC/AAC，1920×1080，约 10.5MB/4.6MB），分别播放至 10.03 秒、10.01 秒后暂停；截图与结果保存在本机发行记录中。
- Mac：两架构 App/DMG 完成 Developer ID 签名、Apple 公证与装订；arm64 App `27f7df39-f78c-438d-8b2c-da5bcf7cd58c`、arm64 DMG `c3b2f06e-c3db-4017-ac00-700610434b3b`、x64 App `a1b7e503-17a8-4690-8161-7bfdb73a22e5`、x64 DMG `8120f7ec-d59a-43a6-8373-060b72274825`。两份 DMG 只读挂载后版本、签名和装订核对通过。
- Windows：[Windows CI](https://github.com/jackotom/hongguo-drama/actions/runs/40311819587) 成功，完成便携播放、安装启动、同版本重装和真实 1.80 → 3.8 升级资料保留；EXE 为 **NotSigned**。

## 实现位置

- [main.js](../main.js)：官网搜索没有标题匹配或接口失败时的 App 上新补搜、合并去重和错误隔离。
- [hongguo-app-new.js](../src/native/hongguo-app-new.js)：App 近 7 天上新目录读取、60 秒缓存、标题匹配。
- [SearchPanel.jsx](../src/components/SearchPanel.jsx)：补搜结果标记和提示。
- [searchRanking.mjs](../src/components/searchRanking.mjs)：反向匹配按标题命中排序。
- [hongguo-app-new.test.cjs](../src/native/hongguo-app-new.test.cjs)、[search-ranking.test.mjs](../src/components/__tests__/search-ranking.test.mjs)：本轮新增回归。

## 边界

- 每类只取 App 上新列表前 50 条；当天新剧在顶部，极繁忙日期超出 50 条的同日条目可能落在补搜范围外。
- App 目录缓存 60 秒；App 元数据接口偶发失败时仍以官网结果为准。
- 5 字以上的极端前缀遮蔽不覆盖；官网已有精确同名结果时不补搜。
- 未在实体 Intel Mac、实体 Windows、启用 Gatekeeper 的干净系统和完整应用内更新上验证本次改动；真实播放验收范围见发行记录。
- 欢迎在 [Issues](https://github.com/jackotom/hongguo-drama/issues) 反馈具体剧名、大概上线时间和复现步骤。

发行资产：[v3.8](https://github.com/jackotom/hongguo-drama/releases/tag/v3.8)。
