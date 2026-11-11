# 红果短剧 3.7

**状态：正式发布。** 内部版本 `3.7.0`，标签 `v3.7`，于 2026-10-26 发布。三端 16 项附件的远端 SHA256 与大小已核对；双 Mac App 与 DMG 完成 Developer ID 签名、Apple 公证 Accepted 和票据装订；Windows EXE 未签名。冻结源码 `85920561b68e0d5cc6ef10f5e6c2c33e96659f09`。

## 观看记录检测

- 每条记录新增「检测」按钮，只检查这一条；检测中显示行内状态，失败可直接重试。
- 同一来源、同一基础剧名的多个季按剧族分组。最高季只执行一次续作搜索，低季复用搜索候选；每季自己的分集列表仍逐条检查，不能拿最高季集数替代低季。
- 批量检测提供「全部记录」「仅最高季」「仅未看完」「排除已看完低季」四种范围。
- 已看完的低季自动检测间隔为 24 小时；未看完记录和最高季仍按 6 小时检查。手动检测不受此间隔限制。
- 单条分集请求限时 10 秒，批量总预算 90 秒；剧族和分集检查使用有限并发。预算用完后保留剩余记录，并明确提示继续检查。
- 分集更新失败和续作搜索失败分开保存、分开显示。续作搜索结果缓存 30 分钟，失败结果冷却 5 分钟。
- 批量检测推送当前进度；同一记录正在检测时复用同一个请求，避免重复写入播放进度。

## 实现位置

- [main.js](../main.js)：剧族分组、检测范围、预算、并发、进度、续作缓存与单条 IPC。
- [watch-history.js](../src/native/watch-history.js)：观看记录字段、最高季标记、分集更新基线。
- [series-search.js](../src/native/series-search.js)：返回未过滤的续作候选，供同一剧族的低季复用。
- [WatchHistory.jsx](../src/components/WatchHistory.jsx)：单条检测按钮、范围选择、进度和分类错误提示。

## 本地验证

- `npm run build:react`：Vite 生产构建通过，91 个模块完成转换。
- `npm test`：全部单元测试与 87 项平台检查通过；包含本轮新增的观看记录检查。
- Mac：两架构 App/DMG 公证 Accepted、装订、只读挂载、版本、签名和更新清单核对通过。
- Windows CI [40288846088](https://github.com/jackotom/hongguo-drama/actions/runs/40288846088)：便携播放、安装启动、同版本重装和真实 1.80 → 3.7 升级资料保留通过。
- `node scripts/check-watch-history.cjs`：8/8，通过单条检测、批量范围转发和续作播放。
- `node scripts/check-watch-history-3.7.cjs`：4/4，通过剧族只搜一次、每季独立拉取、仅最高季、自动低季间隔、单条检测和错误拆分。
- `node scripts/check-watch-history-backend.cjs`：6/6，通过三来源续作搜索、部分失败保留和本地候选。
- `node scripts/check-watch-history-integration.cjs`：4/4，通过 IPC 持久化、并发保存保护和已读状态。
- `node scripts/check-series-search.cjs`：13/13，通过续作搜索预算、同名同源匹配和 IPC 链路。

## 边界

- 尚未用真实大批量观看记录长时间运行，也未验证实体 Intel Mac、实体 Windows、Gatekeeper 干净系统和完整应用内更新。
- 同名不同剧仍可能被当作同一剧族；界面沿用“疑似续作”语义，不自动合并记录或删除低季。
- Windows EXE 的 Authenticode 状态为 **NotSigned**；Windows CI 虚拟机验证不代表实体 Windows、GPU/HEVC 和长期稳定性。

发行资产：[v3.7](https://github.com/jackotom/hongguo-drama/releases/tag/v3.7)。
