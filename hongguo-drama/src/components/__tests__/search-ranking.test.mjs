import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSearchText, rankSearchResults } from '../searchRanking.mjs';

test('normalization ignores width, spaces and punctuation', () => {
  assert.equal(normalizeSearchText('言出法随，诸天万界 我说了算'), '言出法随诸天万界我说了算');
  assert.equal(normalizeSearchText('  恶犬在身边！ '), '恶犬在身边');
  assert.equal(normalizeSearchText(null), '');
});

test('punctuation differences still rank as a title match', () => {
  const ranked = rankSearchResults([
    { source: 'hongguo', series_id: '1', series_title: '言出法随，诸天万界我说了算' },
    { source: 'hongguo', series_id: '2', series_title: '完全无关的剧' },
  ], '言出法随 诸天万界 我说了算');
  assert.equal(ranked[0].series_id, '1');
  assert.equal(ranked[0].relevance, 0);
  assert.equal(ranked[1].relevance, 3);
});

test('partial titles rank between exact and unrelated results', () => {
  const ranked = rankSearchResults([
    { source: 'hongguo', series_id: '1', series_title: '别的剧' },
    { source: 'hongguo', series_id: '2', series_title: '恶犬在身边' },
    { source: 'hongguo', series_id: '3', series_title: '恶犬' },
  ], '恶犬');
  assert.deepEqual(ranked.map(item => item.series_id), ['3', '2', '1']);
  assert.deepEqual(ranked.map(item => item.relevance), [0, 1, 3]);
});

test('duplicates are dropped per source and missing titles are ignored', () => {
  const ranked = rankSearchResults([
    { source: 'hongguo', series_id: '1', series_title: '同名剧' },
    { source: 'hongguo', series_id: '1', series_title: '同名剧' },
    { source: 'xifan', series_id: '1', series_title: '同名剧' },
    { source: 'hongguo', series_id: '2' },
  ], '同名剧');
  assert.equal(ranked.length, 2);
  assert.deepEqual(ranked.map(item => item.source), ['hongguo', 'xifan']);
});

test('fuzzy results sort before unrelated results but after title matches', () => {
  const ranked = rankSearchResults([
    { source: 'hongguo', series_id: '1', series_title: '完全无关的剧' },
    { source: 'hongguo', series_id: '2', series_title: '补搜到的剧', fuzzy: true },
    { source: 'hongguo', series_id: '3', series_title: '目标剧名' },
  ], '目标剧名');
  assert.deepEqual(ranked.map(item => item.series_id), ['3', '2', '1']);
  assert.equal(ranked[1].relevance, 3);
  assert.equal(ranked[1].fuzzy, true);
});


test('content matches rank after title matches but before unrelated results', () => {
  const ranked = rankSearchResults([
    { source: 'hongguo', series_id: '1', series_title: '完全无关的剧' },
    { source: 'hongguo', series_id: '2', series_title: '工地前的一碗盒饭', series_intro: '这道菜吃了不烧心，工友都喜欢。' },
    { source: 'hongguo', series_id: '3', series_title: '不烧心的烧烤摊' },
  ], '烧心');
  assert.deepEqual(ranked.map(item => item.series_id), ['3', '2', '1']);
  assert.deepEqual(ranked.map(item => item.relevance), [1, 2, 3]);
  assert.equal(ranked[1].contentMatch, true);
});

test('App new-release reverse matches rank as title matches', () => {
  const ranked = rankSearchResults([
    { source: 'hongguo', series_id: '1', series_title: '完全无关的剧' },
    { source: 'hongguo', series_id: '2', series_title: '闪婚', new_release: true },
    { source: 'hongguo', series_id: '3', series_title: '别的剧', series_intro: '我想看闪婚' },
  ], '我想看闪婚');
  assert.deepEqual(ranked.map(item => item.series_id), ['2', '3', '1']);
  assert.equal(ranked[0].relevance, 1);
  assert.equal(ranked[1].relevance, 2);
});
