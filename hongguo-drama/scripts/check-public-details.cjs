const assert = require('node:assert/strict');
const { parsePublicDetails, fetchPublicDetails } = require('../src/native/public-details');
const { publicMetadata } = require('../src/native/catalog');

const html = (detail, extra = {}) => `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { detail_page: {
  isSuccess: true, seriesDetail: detail, seriesSocialInfo: { rating: 9.4, series_like_count: '42', reviews: { total_count: '1', reviews: [{ user_name: '测试读者', content: '括号 } 保留；<script>只是文字', create_time: '1700000000', digg_count: '2', user_avatar: 'javascript:alert(1)' }] } }, ...extra,
} } })};throw Error('remote script must not execute');</script>`;

async function main() {
  assert.equal(publicMetadata({ episode_right_text: '全69集', series_episode_info: { series_status: 3 } }).completion_status, 'completed');
  assert.equal(publicMetadata({ episode_right_text: '更新至12集' }).completion_status, 'ongoing');
  assert.equal(publicMetadata({ series_episode_info: { series_status: 1 }, create_time: '1700000000' }).completion_status, 'unknown');
  assert.equal(publicMetadata({ create_time: '1700000000' }).published_at, null, '录入时间不能冒充首次公开时间');
  const result = parsePublicDetails(html({ series_id: '123456789', first_visible_time: '1700000000' }), '123456789');
  assert.equal(result.published_at, 1700000000000);
  assert.equal(result.rating, 9.4);
  assert.equal(result.like_count, 42);
  assert.equal(result.favorite_count, null);
  assert.equal(result.reviews.items[0].content, '括号 } 保留；<script>只是文字');
  assert.equal(result.reviews.items[0].avatar, '');
  assert.equal(result.episode_reviews, null);
  const player = parsePublicDetails(html({ series_id: '123456789' }, { vid: '987654321', episodeSocialInfo: { episode_like_count: '3', reviews: { total_count: '1', reviews: [{ content: '单集真实评论' }] } } }), '123456789', '987654321');
  assert.equal(player.episode_reviews.items[0].content, '单集真实评论');
  assert.throws(() => parsePublicDetails(html({ series_id: '111111111' }), '123456789'), /剧集不匹配/);
  assert.throws(() => parsePublicDetails(html({ series_id: '123456789' }, { vid: '111111111' }), '123456789', '987654321'), /分集不匹配/);
  assert.throws(() => parsePublicDetails('<html>登录或错误页面</html>', '123456789'));
  assert.equal((await fetchPublicDetails('http://127.0.0.1')).success, false);
  assert.equal((await fetchPublicDetails('123456789', '../private')).success, false);
  console.log('PASS public details: explicit metadata, source identity, public reviews, malformed data and URL boundary');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
