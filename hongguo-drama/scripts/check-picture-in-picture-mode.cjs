const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { mount } = require('./check-player-resume.cjs');

const main = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const moduleFixture = { exports: {} };
vm.runInNewContext(main.slice(main.indexOf('const SETTINGS_KEYS'), main.indexOf("ipcMain.handle('get-settings'"))
  + '\nmodule.exports = applyEditableSettings;', {
  module: moduleFixture, normalizeProxySettings: value => value,
});
for (const mode of ['native', 'custom']) {
  assert.equal(moduleFixture.exports({ floating_player_size: { width: 320, height: 500 } }, { picture_in_picture_mode: mode }).picture_in_picture_mode, mode);
}
assert.throws(() => moduleFixture.exports({}, { picture_in_picture_mode: 'invalid' }), /画中画/);

(async () => {
  let mode = 'native', nativeRequests = 0;
  const ui = mount({ local: true, apiOverrides: { getSettings: async () => ({ picture_in_picture_mode: mode }) } });
  try {
    await ui.flush(); ui.metadata(); await ui.media.play();
    ui.media.requestPictureInPicture = async () => {
      nativeRequests++; ui.document.pictureInPictureElement = ui.media;
      ui.mediaEvents.get('enterpictureinpicture')?.();
    };
    const toggle = () => ui.find(node => typeof node.props.onToggleFloating === 'function').props.onToggleFloating();
    await toggle(); await ui.flush();
    assert.equal(nativeRequests, 1);
    ui.props.active = false; ui.render(); await ui.flush();
    assert.equal(ui.media.paused, false, 'native mode must continue on another main page');
    assert.equal(ui.events.has('keydown'), false, 'native mode must not capture the search page keyboard');
    await toggle(); await ui.flush();
    assert.equal(ui.media.paused, true, 'closing native PiP on another page must pause');
    mode = 'custom'; ui.props.active = true; ui.render(); await ui.flush();
    await toggle(); await ui.flush();
    assert.equal(ui.isFloating(), true, 'the next opening must use the saved custom mode');
    assert.equal(nativeRequests, 1, 'custom mode must not call the native API');
    await toggle(); await ui.flush();
    assert.equal(ui.isFloating(), false);
    console.log('PASS PiP mode: persisted enum, invalid input, native/custom routing, background playback and keyboard isolation');
  } finally { ui.unmount(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
