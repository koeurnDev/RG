// Synthetic regression checks only: no playback, network or actual installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { findSequels, sequelKeyword } = require('../src/native/watch-history');
const { decryptMp4Buffer } = require('../src/native/hongguo');

// Reuse the existing isolated updater and renderer fixtures without running their suites.
function fixtureFrom(file, names) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8').split('(async () => {')[0];
  const context = { require, __dirname, Buffer, console, setImmediate, exports: {} };
  vm.runInNewContext(`${source}\nexports.fixtures = { ${names} };`, context, { filename: file });
  return context.exports.fixtures;
}
const { fixture, macFixture, tick } = fixtureFrom('check-app-update-installer.cjs', 'fixture, macFixture, tick');
const { mount } = fixtureFrom('check-app-update-ui.cjs', 'mount');
const idle = { supported: true, reason: '', status: 'idle', version: null, percent: 0, error: '' };

function box(type, ...parts) {
  const body = Buffer.concat(parts), header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8); header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, body]);
}
function encryptedContainer(format, configs = ['avcC'], entryType = 'encv') {
  const entry = box(entryType, Buffer.alloc(entryType === 'encv' ? 78 : 28),
    ...configs.map(type => box(type, Buffer.from([1, 2, 3, 4]))),
    box('sinf', ...(format ? [box('frma', Buffer.from(format))] : [])));
  const count = Buffer.alloc(8); count.writeUInt32BE(1, 4);
  return box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsd', count, entry))))));
}
function restoredEntry(format, configs, entryType) {
  const bytes = decryptMp4Buffer(encryptedContainer(format, configs, entryType), Buffer.alloc(16));
  const stsd = bytes.indexOf(Buffer.from('stsd'));
  assert.ok(stsd >= 0);
  assert.equal(bytes.includes(Buffer.from('sinf')), false);
  assert.equal(bytes.readUInt32BE(stsd + 12), bytes.length - (stsd + 12));
  return { codec: bytes.toString('latin1', stsd + 16, stsd + 20), bytes };
}

(async () => {
  let passed = 0, failed = 0;
  async function check(name, fn) {
    try { await fn(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  await check('installation errors retain verified download and retry without downloading', async () => {
    const f = fixture();
    const download = f.controller.download('1.81'); f.checked(); await tick(); f.downloaded(); await download;
    f.controller.install(); await tick(); f.updater.emit('error', Error('install failed'));
    assert.equal(f.controller.install().success, true, 'native failure must allow direct install retry');
    await tick(); assert.equal(f.counts().installs, 2); assert.equal(f.counts().downloads, 1);
    f.controller.cancel(); assert.equal(f.controller.install().success, false);
    const mac = macFixture(); await mac.ready();
    mac.native.checkForUpdates = () => { throw Error('native prep unavailable'); };
    mac.controller.install(); await tick();
    assert.equal(mac.controller.getState().status, 'error');
    mac.native.checkForUpdates = () => {};
    assert.equal(mac.controller.install().success, true, 'synchronous preparation failure must be retryable');
    await tick(); mac.native.emit('update-downloaded'); assert.equal(mac.nativeCounts().quits, 1);
    assert.equal(mac.counts().downloads, 1);
    const failedDownload = fixture(), pending = failedDownload.controller.download('1.81');
    failedDownload.checked(); await tick(); failedDownload.downloaded(Error('checksum mismatch')); await pending;
    assert.equal(failedDownload.controller.install().success, false, 'failed checksum cannot install');
  });
  await check('installation error UI retries installation using the retained download', async () => {
    let installs = 0, downloads = 0;
    const ui = mount({ getAppUpdateState: async () => ({ ...idle, status: 'error', version: '9.0', downloaded: true, error: '安装失败' }),
      installAppUpdate: async () => { installs++; return { success: true }; },
      downloadAppUpdate: async () => { downloads++; return { success: true }; } });
    await ui.flush();
    assert.ok(ui.button('重启并安装'), 'install error should keep the install button');
    await ui.button('重启并安装').props.onClick(); assert.equal(installs, 1); assert.equal(downloads, 0);
    assert.ok(ui.text().includes('安装失败')); ui.unmount();
  });
  await check('sequel matching preserves year suffixes and accepts explicit and modest bracket seasons', () => {
    const original = { series_id: '1000001', series_title: '春日来信' };
    assert.equal(sequelKeyword({ series_title: '春日来信（2024）' }), '春日来信(2024)');
    assert.deepEqual(findSequels(original, [{ series_id: '1000002', series_title: '春日来信（2024）' }]), []);
    for (const suffix of ['（2）', '(二)', '（十二）', '第两部', '第十二季', '第一百季', 'season2', '（９９）']) {
      assert.equal(findSequels(original, [{ series_id: '1000002', series_title: `春日来信${suffix}` }]).length, 1, suffix);
    }
    for (const suffix of ['(0)', '(100)', '(二〇二四)', '(二零二四)', '(一百)', '第0季']) {
      assert.equal(findSequels(original, [{ series_id: '1000002', series_title: `春日来信${suffix}` }]).length, 0, suffix);
    }
    assert.equal(findSequels({ ...original, series_title: '春日来信（十二）' }, [{ series_id: '1000002', series_title: '春日来信第十三季' }]).length, 1);
  });
  await check('synthetic encrypted sample entries preserve AVC/HEVC codecs and reject ambiguity', () => {
    for (const [format, configs] of [['avc1', ['avcC']], ['avc3', ['avcC']], ['hvc1', ['hvcC']], ['hev1', ['hvcC']]]) {
      const result = restoredEntry(format, configs);
      assert.equal(result.codec, format);
      assert.ok(result.bytes.includes(Buffer.from(configs[0])), 'decoder configuration must remain');
    }
    assert.equal(restoredEntry(null, ['avcC']).codec, 'avc1');
    assert.equal(restoredEntry(null, ['hvcC']).codec, 'hvc1');
    assert.equal(restoredEntry('mp4a', ['esds'], 'enca').codec, 'mp4a');
    for (const [format, configs] of [[null, []], [null, ['avcC', 'hvcC']], ['avc1', ['hvcC']], ['hvc1', ['avcC']], ['av01', ['av1C']]]) {
      assert.throws(() => restoredEntry(format, configs), /codec|编码/i);
    }
  });
  console.log(`Native review 2.5: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
