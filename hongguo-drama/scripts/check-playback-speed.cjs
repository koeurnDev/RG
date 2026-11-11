const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');

(async () => {
  const ui = mount({ local: true });
  await ui.flush(); ui.metadata();
  const controls = () => ui.find(n => n.props.videoRef && typeof n.props.onRateChange === 'function');
  const video = () => ui.find(n => n.type === 'video');
  const key = (value, extra = {}) => ui.events.get('keydown')({ key: value, target: { closest: () => null }, preventDefault() {}, ...extra });
  assert.ok(controls(), 'player must connect its video controls');
  controls().props.onRateChange(4); ui.render();
  assert.equal(ui.media.playbackRate, 4); assert.equal(ui.media.defaultPlaybackRate, 4);
  const notice = () => ui.find(n => n.props.className === 'player-rate-notice');
  assert.ok(notice(), 'button speed changes must show a dedicated in-video notice');
  assert.ok(notice().children.join('').includes('4'), 'notice reports the applied speed');
  assert.equal(ui.find(n => n.props.className === 'dm-toast dm-toast-success'), undefined, 'speed feedback must not use the page-bottom toast');
  const oldTimer = [...ui.timers].find(([, timer]) => timer.delay === 1800)?.[0];
  key('s'); ui.render(); assert.ok(notice().children.join('').includes('3.75'), 'keyboard changes update the same notice');
  assert.equal(ui.timers.has(oldTimer), false, 'repeated speed changes restart the notice expiry');
  const expiry = [...ui.timers].find(([, timer]) => timer.delay === 1800); assert.ok(expiry);
  ui.timers.delete(expiry[0]); expiry[1].fn(); ui.render(); assert.equal(notice(), undefined, 'notice clears without changing playback');
  controls().props.onRateChange(4); ui.render();

  key('d'); assert.equal(ui.media.playbackRate, 4);
  key('s'); assert.equal(ui.media.playbackRate, 3.75);
  for (let i = 0; i < 20; i++) key('s');
  assert.equal(ui.media.playbackRate, 0.25);
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey', 'isComposing']) {
    key('d', { [modifier]: true }); assert.equal(ui.media.playbackRate, 0.25, `${modifier} must suppress shortcuts`);
  }
  key('d', { target: { closest: () => ({}) } }); assert.equal(ui.media.playbackRate, 0.25, 'editing controls must suppress shortcuts');
  key('d', { target: { isContentEditable: true, closest: () => null } }); assert.equal(ui.media.playbackRate, 0.25, 'inherited editable targets must suppress shortcuts');
  key('d'); ui.render(); assert.equal(controls().props.rate, 0.5);
  controls().props.onRateChange(3.5); ui.render();
  video().props.onEnded(); await ui.flush();
  ui.media.playbackRate = 1; video().props.onRateChange({ currentTarget: ui.media });
  ui.metadata(); ui.render();
  assert.equal(ui.media.playbackRate, 3.5, 'auto-next must restore selected speed after media load');
  assert.equal(ui.media.defaultPlaybackRate, 3.5);
  ui.media.playbackRate = 2.5; video().props.onRateChange({ currentTarget: ui.media }); ui.render();
  assert.equal(controls().props.rate, 2.5, 'media rate changes must update video controls');
  assert.equal(ui.media.defaultPlaybackRate, 2.5);
  ui.episode(1); await ui.flush(); ui.metadata(); assert.equal(ui.media.playbackRate, 2.5);
  ui.props.active = false; ui.render(); assert.equal(ui.events.has('keydown'), false);
  ui.unmount();

  const history = mount({ saved: { vid_index: 2, currentTime: 37 }, props: { target: { seriesId: 'A', vidIndex: 2, resume: true, ts: 1 } } });
  await history.flush(); assert.equal(history.saves.length, 0, 'preparing a stream must not create a watched entry');
  history.metadata(); assert.equal(history.media.currentTime, 37, 'history resume must preserve saved second');
  assert.ok(history.saves.some(row => row[1] === 2 && row[2] === 37), 'real play must save the watched entry');
  history.unmount();
  const buffering = mount({ local: true });
  await buffering.flush();
  buffering.media.play = async () => { buffering.find(n => n.type === 'video').props.onPlay({ currentTarget: buffering.media }); };
  buffering.metadata(); buffering.find(n => n.type === 'video').props.onPause(); buffering.unmount();
  assert.equal(buffering.saves.length, 0, 'play intent without playing must not create watched history');
  const blocked = mount({ local: true });
  await blocked.flush(); blocked.media.play = async () => { throw new Error('autoplay blocked'); };
  blocked.metadata(); blocked.find(n => n.type === 'video').props.onPause();
  blocked.episode(2); await blocked.flush(); blocked.metadata(); blocked.unmount();
  assert.equal(blocked.saves.length, 0, 'metadata, failed play, pause and switching must not count as watched');
  console.log('PASS playback speed range, shortcuts, control sync, episode continuity and real-play history');
})().catch(error => { console.error(error); process.exitCode = 1; });
