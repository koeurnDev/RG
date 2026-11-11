# 当前集评论的公开来源边界

本文只描述“本集评论”备用来源。2.9 新增的时间轴弹幕使用另一条非公开签名来源，参见 [2.9 说明](release-2.9.md)。

核对时间：2026-10-13。只读取官方匿名网页与其加载的公开脚本，没有使用账户、Cookie、签名接口或受保护播放接口。

## 来源证据

- 样本页面：`https://hongguoduanju.com/player/7503745441910017049/7503780574541122622`。
- HTML 的 `episodeSocialInfo.reviews` 包含 `total_count` 和 `reviews`，没有分页游标。样本首集返回 15 条，平台总数 15536；第二集 `7503780577347128382` 返回 15 条，总数 7055。总数不等于公开网页可读取条数。
- 官方公开脚本前缀：`https://lf-fe.fqnovelstatic.com/obj/novel-fanqie-fe/growth/incentive-h5-monorepo/apps/hongguo/static/js/async/`。
- `2961.461200625d.js` 的评论组件执行 `reviews.slice(0,p?9:15)`；横向滚动只滚动现有元素，更多按钮调用 `onActivate`。
- `867.e5ae099b3e.js` 将评论更多动作接到 `openCommentGuide`，按钮原文为“前往红果短剧App查看更多评论”。
- 检查该播放器页面加载的应用脚本后，未找到可用的匿名评论分页请求。此结论仅覆盖已检查的公开网页，不断言官方 App 或其他受保护来源不存在分页。

## 本地契约

`getEpisodeComments({ seriesId, episodeId, cursor: null, limit: 30 })`

返回 `success`、`series_id`、`episode_id`、`items: [{ id, content }]`、`total`、`next_cursor: null`、`has_more: false`、`source_limited: true` 和 `notice`。

- `source_limited` 必须优先于“全部已加载”之类的结束状态展示。
- 任何非空游标均明确失败，不重新抓首屏来冒充下一页。
- 来源没有公开评论 ID；本地 ID 取剧集、分集、作者、时间和内容的 SHA-256。点赞数变化不会导致同一评论重新进入队列。同名作者、相同时间和内容会合并。
- 复用公开详情模块的 30 秒缓存、并发请求去重、超时、响应大小上限和剧集/分集身份校验。只返回内容与本地 ID，不向前端评论队列增加用户头像或作者资料。
- 将来只有取得真实公开分页接口证据后才能启用非空游标。届时需验证跨页去重、游标前进、末页与错误行为。

## 本次验证

- `node src/native/episode-comments.test.cjs`：输入与游标拒绝、稳定 ID、去重、来源限制、缓存、分集隔离通过。
- 匿名实读上述两集：分别得到 15 个唯一 ID；剧集/分集匹配，均明确返回来源受限、无下一页。未验证到真实分页，也未实现或声称持续加载全量评论。
