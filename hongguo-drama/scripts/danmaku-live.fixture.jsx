import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import CommentDanmaku from '../src/components/CommentDanmaku.jsx';
import PlayerControls from '../src/components/PlayerControls.jsx';
import { createCommentFeed, DEFAULT_DANMAKU_SETTINGS } from '../src/components/danmakuModel.mjs';

window.IS_REACT_ACT_ENVIRONMENT = true;
window.testResult = (async () => {
  const assert = (value, message) => { if (!value) throw Error(message); };
  const root = createRoot(document.getElementById('root'));
  const video = Object.assign(new EventTarget(), { paused: false, ended: false, seeking: false, readyState: 4, playbackRate: 1, currentTime: 0, duration: 120, volume: 1, muted: false });
  const videoRef = { current: video }, stageRef = { current: null }, feed = createCommentFeed('123456', '654321');
  feed.comments = Array.from({ length: 30 }, (_, i) => ({ content: `评论${i}：测试屏上内容保持原位` }));
  let settings = { ...DEFAULT_DANMAKU_SETTINGS, area: 'full', density: 'dense' };
  let now = 1000, serial = 0;
  const frames = new Map();
  window.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
  window.cancelAnimationFrame = id => frames.delete(id);
  const render = (status = {}) => act(async () => root.render(<div ref={stageRef} style={{ position: 'relative', width: 800, height: 600 }}>
    <CommentDanmaku videoRef={videoRef} source="fixture" available danmaku={{ running: true, settings, comments: feed.comments, feed, ...status }} />
    <PlayerControls videoRef={videoRef} stageRef={stageRef} source="fixture" available rate={1} onRateChange={() => {}} />
  </div>));
  const advance = async count => { for (let i = 0; i < count; i++) await act(async () => {
    now += 100; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(now));
  }); };
  // The fixture omits application CSS; supply only the real overlay's geometry.
  const style = document.createElement('style');
  style.textContent = '.comment-danmaku,.player-controls{position:absolute;inset:0}.player-controls-bar{position:absolute;inset:auto 0 0;height:80px}.comment-danmaku-item{position:absolute;white-space:nowrap;line-height:1.25}';
  document.head.append(style);
  const snapshot = () => feed.animation.items.map(item => ({ ...item, node: [...document.querySelectorAll('.comment-danmaku-item')].find(node => node.textContent === item.text) }));
  try {
    for (const status of [
      { loading: true, status: '正在加载本集评论…' },
      { error: '本集评论加载失败，可重试继续加载', status: '本集评论加载失败，可重试继续加载' },
      { comments: [], status: '本集暂无可显示的公开评论' },
      { feed: { ...feed, notice: '官网仅提供本集部分评论' }, status: '官网仅提供本集部分评论' },
    ]) {
      await render(status);
      assert(!document.querySelector('.comment-danmaku').textContent.includes(status.status), `Comment status obstructed video: ${status.status}`);
    }
    await render(); await advance(34);
    await act(async () => { video.paused = true; video.dispatchEvent(new Event('pause')); });
    const before = snapshot(), cursor = feed.animation.cursor;
    assert(before.length >= 3, 'Full-stage controls overlay must preserve multiple danmaku lanes above the bottom bar');
    for (const patch of [{ opacity: 35 }, { fontSize: 32 }, { speed: 2 }, { area: 'quarter' }, { density: 'sparse' }]) {
      settings = { ...settings, ...patch }; await render();
      const after = snapshot();
      assert(after.length === before.length, `Settings cleared live comments: ${JSON.stringify(patch)}, ${before.length} became ${after.length}`);
      assert(feed.animation.cursor === cursor, 'Setting consumed another comment');
      after.forEach((item, i) => {
        assert(item.id === before[i].id && item.node === before[i].node && item.node.isConnected, 'Live comment DOM identity changed');
        assert(item.text === before[i].text && item.x === before[i].x && item.age === before[i].age, 'Setting reset text, position or age');
        assert(item.width === (Array.from(item.text).length + 1) * settings.fontSize, 'Existing width did not follow font size');
      });
      const layer = document.querySelector('.comment-danmaku > div');
      assert(Number(layer.style.opacity) === settings.opacity / 100 && parseFloat(layer.style.fontSize) === settings.fontSize, 'Paused styles did not update');
    }
    const target = before[1]; settings = { ...settings, blockedWords: target.text }; await render();
    assert(!target.node.isConnected && feed.animation.items.length === before.length - 1, 'Filter must remove only the matching comment');
    assert(before.filter(item => item !== target).every(item => item.node.isConnected), 'Filter removed unrelated comments');
    const x = feed.animation.items[0].x;
    await act(async () => { video.paused = false; video.dispatchEvent(new Event('play')); }); await advance(2);
    assert(Math.abs(x - feed.animation.items[0].x - 85 * 2 * 0.101) < 0.001, 'New speed did not apply to existing comments');
    const moving = feed.animation.items[0];
    assert(before[0].node.style.transform === `translate(${moving.x}px, ${moving.y}px)`, 'Existing DOM stopped moving after settings changed');
    settings = { ...settings, density: 'dense', area: 'half' }; await render(); await advance(40);
    const items = feed.animation.items;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++)
      assert(Math.abs(items[i].y - items[j].y) >= settings.fontSize + 12, 'Settings caused overlapping lanes');
    return { passed: true, preservedComments: before.length, checks: ['loading/error/empty/limited status stays off video', 'DOM identity, text, x, age, cursor', 'paused opacity/font/width', 'selective filtering', 'live speed', 'safe lane admission after area/density changes'] };
  } catch (error) { return { passed: false, error: error.message }; }
  finally { await act(async () => root.unmount()); }
})();
