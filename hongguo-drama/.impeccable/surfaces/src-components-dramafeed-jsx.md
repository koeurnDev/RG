---
version: 1
slug: "src-components-dramafeed-jsx"
primary_target: "src/components/DramaFeed.jsx"
related_targets: ["src/components/RandomDrama.jsx"]
---

# 热播推荐与摇一摇

Mode: Operate. Audience: 桌面短剧观看者，想从真实片单中快速选一部。
Scope: DramaFeed 与 RandomDrama；继承既有米白、柔和红和浅深主题，不改全局导航、播放器或数据格式。

## Direction contract
THESIS: 一屏选好一部。热播用海报与播放动作聚焦当前剧，随后小海报预告后续；摇一摇把选择困难转成一次可撤销的抽签。
OWN-WORLD: 沿用 DESIGN.md 暖中性色、珊瑚红、系统字体和克制圆角；来源与状态使用现有主题变量。
STORY: 先选四个公开热播榜或独立的摇一摇，再看真实封面、剧名和来源，在剧库播放。免费可用性由分集解析决定。
FIRST VIEWPORT: 标题及刷新在上，分类横排；热播主体左侧 3:4 海报、右侧标题与播放，底部前后切换和后续剧目。摇一摇主体为居中签筒按钮，来源在上方；抽后显示来源、海报、剧名和两个动作。
FORM: Brief-pinned existing-surface extension；seed key: not applicable（明确指定局部签筒方案，无概念抽选）。Code-led；原创平面 SVG 几何签筒，无栅格素材。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Behavior and boundaries
- 每来源只请求目录第一页，全部来源为每个内置与已启用自定义源各一个 browseList 请求，单来源保留最多 60 部；不声称覆盖全站或所有来源热播。
- 允许来源部分失败；可用内容仍能抽取并提示缺失来源。ID 校验、去重、避免连续同 ID 或同名；无另一部时明确提示。
- 620ms 签筒摇动；减少动态效果设置下立即出结果。原生按钮和 select 支持键盘；窄屏结果保留两个明确动作。
- 请求超时、取消、切页和切来源取消后续 UI 工作。IPC 不支持传输层取消，已发出请求在原有服务超时机制下结束。
- 复用 searchResolve/playSeries，只打开未 locked 的有效分集；响应 ID 不匹配不播放。

## Verification handoff
随机与共享来源模型 11 个定向 Node 测试已红绿通过；四个变更 JSX/CSS 经 esbuild 解析通过；Impeccable detector 返回 []。主控统一做真实来源、浅深主题、竖屏和键盘验收与 finish review；本记录不宣称已完成浏览器验收。
预存 design.json 漂移未修复；普通扩展不变更 DESIGN.md 全局设计系统。


## 自定义来源扩展（Issue 10）
设置提供苹果 CMS V10 JSON 来源名称、API 地址、测试连接、保存、编辑、启停与明确确认的移除；移除只改配置，不删除本地视频。既有设置风格保持不变，表单两列在窄屏变单列。
共享 useMediaSources 一次读取可用来源；设置变更本机广播触发统一刷新。发现、搜索和摇一摇共同使用启用列表，来源变更时旧请求结果失效。全部搜索和全部随机包含启用的自定义源；名称用于来源标签，未启用或移除时不冒充红果。
自定义目录说明按来源顺序显示，不称热播；MP4/M3U8直链能力以实际接口为准，无网页/插件/付费解锁承诺。
验证新增：来源格式和禁用过滤、共享请求合并、迟到旧响应、读取失败保留旧列表、自定义抽取ID隔离；8个自定义源UI文件解析通过；机械检测无发现。真实来源与UI验收仍由主控统一执行。
