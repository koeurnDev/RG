// Silent black-frame regression through the real merge IPC. No GUI or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { buildMergePlan, readMergeInfo } = require('../src/native/merge-plan');
const { cleanupMergeTemps } = require('../src/native/merge-runner');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-merge-'));
const bin = name => process.env[name.toUpperCase()] || path.resolve(__dirname, '../build/ffmpeg/darwin-arm64', name);
const run = (name, args) => execFileSync(bin(name), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 110000 });
const probe = file => JSON.parse(run('ffprobe', ['-v', 'error', '-show_data_hash', 'sha256', '-show_streams', '-show_format', '-of', 'json', file]));
const probeFrames = file => JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
  '-show_entries', 'frame=width,height,best_effort_timestamp_time', '-of', 'json', file])).frames;
function video(file, width, height, { pixelFormat = 'yuv420p', codec = 'h264', color = 'black' } = {}) {
  const encoder = codec === 'hevc' ? (process.platform === 'darwin' ? 'hevc_videotoolbox' : 'libx265') : 'libx264';
  return run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:r=24:d=1`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1', '-c:v', encoder, ...(encoder === 'libx265' ? ['-x265-params', 'log-level=error:pools=1'] : []),
    '-pix_fmt', pixelFormat, '-c:a', 'aac', file]);
}
function assertFrameSizes(file, files, expectedSizes) {
  const boundaries = [];
  let end = 0;
  for (const source of files) {
    end += Number(probe(source).format.duration);
    boundaries.push(end);
  }
  const counts = expectedSizes.map(() => 0);
  const frames = probeFrames(file);
  for (const frame of frames) {
    const time = Math.max(0, Number(frame.best_effort_timestamp_time));
    const found = boundaries.findIndex(boundary => time < boundary - 0.001);
    const index = found < 0 ? boundaries.length - 1 : found;
    assert.deepEqual([Number(frame.width), Number(frame.height)], expectedSizes[index], `wrong frame size at ${time.toFixed(3)}s`);
    counts[index]++;
  }
  assert.ok(counts.every(count => count >= 20), `incomplete per-episode frames: ${counts.join('/')}`);
  return frames;
}
async function merge(label, files, compatible, mode = '', expected = null, requestOptions = {}) {
  const originals = files.map(file => { const stat = fs.statSync(file); return [stat.size, stat.mtimeMs]; });
  const handlers = {}, app = new EventEmitter();
  let savedTasks = [], saveCalls = 0, addedTasks = 0;
  Object.assign(app, { getVersion: () => 'test', getPath: () => root, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (n, fn) => handlers[n] = fn }, protocol: { registerSchemesAsPrivileged() {} } };
  const store = { getSettings: () => ({}), saveMergeTasks: tasks => { savedTasks = tasks; saveCalls++; } };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : name === './src/store' ? store : req(name), __dirname: path.dirname(source), process, console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context);
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  context.resolveFfmpeg = mode === 'ffmpeg-fail' ? name => name === 'ffmpeg' ? process.execPath : bin(name) : bin;
  const actualProbe = context.probeVideoInfo, probeCalls = [];
  context.probeVideoInfo = async (...args) => {
    const file = path.resolve(args[1]);
    probeCalls.push(file);
    if (mode === 'quality-probe-fail' && file === path.resolve(files[1])) return null;
    return actualProbe(...args);
  };
  context.pickH264Encoder = async () => mode === 'fallback' ? 'unavailable_test_encoder' : process.env.MERGE_ENCODER || 'libx264';
  context.collectSeriesEpisodeFiles = () => ({ dir: root, ordered: files.map((file, i) => ({ path: file, vid_index: i + 1 })) });
  let finish;
  const settled = new Promise(resolve => { finish = resolve; });
  context.sendToRenderer = (event, data) => {
    if (event === 'merge-task-added') addedTasks++;
    if ((mode === 'cancel' || mode === 'cancel-ts') && event === 'merge-progress'
      && (mode === 'cancel' || data.done >= 1)) handlers['cancel-merge']({}, data.id);
    if (['merge-completed', 'merge-failed'].includes(event)) finish({ event, ...data });
  };
  const started = await handlers['merge-series']({}, 'fixture', label, { compatible, ...requestOptions });
  if (mode === 'quality-reject' || mode === 'quality-probe-fail') {
    assert.equal(started.success, false);
    assert.equal(started.code, 'MERGE_1080_UNAVAILABLE');
    if (mode === 'quality-reject') assert.match(started.error, /第 2 集实际为 720P/);
    else assert.match(started.error, /第 2 集视频信息读取失败/);
    assert.equal(saveCalls, 0, 'rejected quality gate persisted a task');
    assert.equal(addedTasks, 0, 'rejected quality gate emitted a task');
    assert.equal(vm.runInContext('mergeTasks.length', context), 0, 'rejected quality gate created a task');
    assert.equal(fs.existsSync(path.join(root, `${label}.mp4`)), false, 'rejected quality gate created output');
    assert.equal(probeCalls.length, files.length, 'quality gate must probe each downloaded source once');
    assert.ok(probeCalls.every(file => files.some(source => path.resolve(source) === file)), 'quality gate must not probe non-source files');
    for (let i = 0; i < files.length; i++) { const stat = fs.statSync(files[i]); assert.deepEqual([stat.size, stat.mtimeMs], originals[i], 'source file changed'); }
    assert.ok(!fs.readdirSync(root).some(file => file.startsWith('.merge-')), 'rejected quality gate left temporary files');
    console.log(`PASS ${label}: ${started.code}, no task/output/temp, sources unchanged`);
    return;
  }
  assert.equal(started.success, true, started.error);
  let timer;
  const result = await Promise.race([settled, new Promise(resolve => { timer = setTimeout(() => resolve({ error: 'merge did not settle' }), 110000); })]);
  clearTimeout(timer);
  for (let i = 0; i < files.length; i++) { const stat = fs.statSync(files[i]); assert.deepEqual([stat.size, stat.mtimeMs], originals[i], 'source file changed'); }
  assert.ok(!fs.readdirSync(root).some(file => file.startsWith('.merge-') || file.endsWith('.part') || file.endsWith('.ffconcat.txt')), 'temporary files remain');
  assert.ok(probeCalls.every(file => files.some(source => path.resolve(source) === file)), 'later normalization/output probes are not allowed');
  if (mode === 'cancel' || mode === 'cancel-ts') {
    assert.equal(result.event, 'merge-failed'); assert.equal(result.error, '已取消');
    assert.equal(fs.existsSync(started.output), false, 'cancel published a partial output');
    console.log('PASS cancellation: child stopped, partial files removed, sources unchanged');
    return;
  }
  assert.equal(probeCalls.length, files.length, 'completed or failed merges must probe each source exactly once');
  if (mode === 'ffmpeg-fail') {
    assert.equal(result.event, 'merge-failed');
    assert.match(result.error, /FFmpeg 退出码/);
    assert.equal(fs.existsSync(started.output), false, 'FFmpeg failure published output');
    console.log('PASS FFmpeg failure: no output published, temporary files removed, sources unchanged');
    return;
  }
  assert.equal(result.event, 'merge-completed', result.error);
  const info = probe(started.output);
  const expectedDuration = files.reduce((sum, file) => sum + Number(probe(file).format.duration), 0);
  assert.ok(Math.abs(Number(info.format.duration) - expectedDuration) < 0.4, 'lost episode duration');
  const videoInfo = info.streams.find(s => s.codec_type === 'video');
  assert.equal(videoInfo.codec_name, expected?.codec || 'h264');
  if (expected?.tag) assert.equal(videoInfo.codec_tag_string, expected.tag);
  assert.equal(info.streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
  const outputFrames = expected?.sizes ? assertFrameSizes(started.output, files, expected.sizes) : [];
  // Decode all synthetic frames; real files only decode across their join, never play them.
  const seek = process.argv.includes('--real') ? ['-ss', String(Math.max(0, Number(probe(files[0]).format.duration) - 1)), '-t', '2'] : [];
  const decoded = run('ffmpeg', ['-v', 'error', '-xerror', ...seek, '-i', started.output, '-progress', 'pipe:1', '-f', 'null', '-']);
  const frames = [...decoded.matchAll(/^frame=(\d+)/gm)].map(match => Number(match[1]));
  const expectedFrames = files.length * 20;
  assert.ok(frames.at(-1) >= expectedFrames, `lost video after codec boundary: decoded ${frames.at(-1)} frames, expected at least ${expectedFrames}`);
  assert.ok(files.every(file => fs.existsSync(file)), 'source files were removed');
  const task = savedTasks.find(item => item.id === result.id);
  const method = task?.method;
  if (expected?.method) assert.equal(method, expected.method);
  assert.equal(task?.verified, '', 'completion must not claim a post-merge verification');
  assert.equal(task?.stageText, '合并完成');
  const sizes = [...new Set(outputFrames.map(frame => `${frame.width}x${frame.height}`))].join(' -> ');
  console.log(`PASS ${label}: ${videoInfo.codec_name} ${sizes || `${videoInfo.width}x${videoInfo.height}`}, ${method}, ${Number(info.format.duration).toFixed(3)}s, ${frames.at(-1)} frames decoded`);
  return { info, method, path: started.output };
}
(async () => {
  let files;
  if (process.argv.includes('--resolution-only')) {
    const h264 = {
      1080: path.join(root, 'h264-1080.mp4'),
      720: path.join(root, 'h264-720.mp4'),
      480: path.join(root, 'h264-480.mp4'),
      copy: path.join(root, 'h264-1080-copy.mp4'),
      odd: path.join(root, 'h264-odd.mp4'),
      oddCopy: path.join(root, 'h264-odd-copy.mp4')
    };
    const vertical = {
      1080: path.join(root, 'vertical-1080.mp4'),
      720: path.join(root, 'vertical-720.mp4'),
      480: path.join(root, 'vertical-480.mp4')
    };
    const hevc1080 = path.join(root, 'hevc-1080.mp4');
    const hevc720 = path.join(root, 'hevc-720.mp4');
    video(h264[1080], 1920, 1080, { color: 'red' });
    video(h264[720], 1280, 720, { color: 'green' });
    video(h264[480], 854, 480, { color: 'blue' });
    video(vertical[1080], 1080, 1920, { color: 'red' });
    video(vertical[720], 720, 1280, { color: 'green' });
    video(vertical[480], 480, 854, { color: 'blue' });
    video(h264.odd, 853, 479, { pixelFormat: 'yuv444p', color: 'yellow' });
    video(hevc1080, 1920, 1080, { codec: 'hevc', color: 'red' });
    video(hevc720, 1280, 720, { codec: 'hevc', color: 'green' });
    fs.copyFileSync(h264[1080], h264.copy);
    fs.copyFileSync(h264.odd, h264.oddCopy);
    const landscapeSizes = [[1920, 1080], [1280, 720], [854, 480]];
    const reverseSizes = [...landscapeSizes].reverse();
    const verticalSizes = [[1080, 1920], [720, 1280], [480, 854]];
    const h264Dynamic = await merge('h264-1080-720-480-copy', [h264[1080], h264[720], h264[480]], false, '', { tag: 'avc3', sizes: landscapeSizes, method: '无损快速合并' });
    await merge('h264-reverse-copy', [h264[480], h264[720], h264[1080]], false, '', { tag: 'avc3', sizes: reverseSizes, method: '无损快速合并' });
    await merge('vertical-1080-720-480-copy', [vertical[1080], vertical[720], vertical[480]], false, '', { tag: 'avc3', sizes: verticalSizes, method: '无损快速合并' });
    await merge('same-size-1080-copy', [h264[1080], h264.copy], false, '', { sizes: [[1920, 1080], [1920, 1080]], method: '无损快速合并' });
    await merge('quality-1080-success', [h264[1080], h264.copy], false, '', { sizes: [[1920, 1080], [1920, 1080]], method: '无损快速合并' }, { require1080: true });
    await merge('odd-size-copy', [h264.odd, h264.oddCopy], false, '', { sizes: [[853, 479], [853, 479]], method: '无损快速合并' });
    const hevcDynamic = await merge('hevc-dynamic-ts-copy', [hevc1080, hevc720], false, '', { codec: 'hevc', tag: 'hev1', sizes: [[1920, 1080], [1280, 720]], method: '无损统一封装' });
    await merge('mixed-codec-segment-sizes', [h264[1080], hevc720], false, '', { tag: 'avc3', sizes: [[1920, 1080], [1280, 720]], method: '统一视频编码' });
    await merge('mixed-codec-compatible', [h264[1080], hevc720], true, '', { tag: 'avc3', sizes: [[1920, 1080], [1280, 720]], method: '统一视频编码' });
    await merge('quality-1080-mixed-reject', [h264[1080], h264[720]], false, 'quality-reject', null, { require1080: true });
    await merge('quality-1080-probe-reject', [h264[1080], h264[720]], false, 'quality-probe-fail', null, { require1080: true });
    await merge('cancel-hevc-ts', [hevc1080, hevc720], false, 'cancel-ts');
    const orphan = path.join(root, '.merge-Ts1234');
    fs.mkdirSync(orphan); fs.writeFileSync(path.join(orphan, '0.ts'), '');
    const protectedTemp = path.join(root, '.merge-Keep12');
    fs.mkdirSync(protectedTemp); fs.writeFileSync(path.join(protectedTemp, 'notes.txt'), 'keep');
    await cleanupMergeTemps([root]);
    assert.equal(fs.existsSync(orphan), false, 'orphan TS temporary directory was not cleaned');
    assert.equal(fs.existsSync(protectedTemp), true, 'cleanup must not remove unrecognized files');
    fs.rmSync(protectedTemp, { recursive: true, force: true });
    await merge('reject-ffmpeg-failure', [h264[1080], h264[720]], false, 'ffmpeg-fail');
    if (process.env.MERGE_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.MERGE_ARTIFACT_DIR, { recursive: true });
      fs.copyFileSync(h264Dynamic.path, path.join(process.env.MERGE_ARTIFACT_DIR, 'h264-dynamic-1080-720-480.mp4'));
      fs.copyFileSync(hevcDynamic.path, path.join(process.env.MERGE_ARTIFACT_DIR, 'hevc-dynamic-1080-720.mp4'));
    }
    const dynamicPlan = buildMergePlan([h264[1080], h264[720], h264[480]].map(file => readMergeInfo(probe(file))));
    assert.equal(dynamicPlan.videoMode, 'copy', 'different H.264 dimensions/SPS must keep lossless copy');
    assert.equal(dynamicPlan.videoTag, 'avc3');
    const mixedPlan = buildMergePlan([h264[1080], hevc720].map(file => readMergeInfo(probe(file))));
    assert.equal(mixedPlan.videoMode, 'encode', 'mixed codecs must use the safe per-episode encoder path');
    const hevcPlan = buildMergePlan([hevc1080, hevc720].map(file => readMergeInfo(probe(file))));
    assert.equal(hevcPlan.videoMode, 'copy');
    assert.equal(hevcPlan.videoContainer, 'mpegts', 'HEVC resolution changes must use lossless TS transport');
    assert.equal(hevcPlan.videoTag, 'hev1');
    return;
  }
  if (process.argv.includes('--real')) files = process.argv.slice(process.argv.indexOf('--real') + 1);
  else {
    files = ['h264', 'hevc'].map(codec => path.join(root, `${codec}.mp4`));
    for (let i = 0; i < files.length; i++) run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=24:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1', '-c:v', i ? (process.platform === 'darwin' ? 'hevc_videotoolbox' : 'libx265') : 'libx264', ...(i && process.platform !== 'darwin' ? ['-x265-params', 'log-level=error:pools=1'] : []), '-pix_fmt', 'yuv420p', '-c:a', 'aac', files[i]]);
  }
  assert.equal(files.length, 2);
  if (process.argv.includes('--extras')) {
    await merge('hardware-fallback', files, true, 'fallback');
    await merge('cancel-normalization', files, true, 'cancel');
    return;
  }
  await merge('mixed-fast', files, false);
  if (!process.argv.includes('--real')) {
    await merge('mixed-compatible', files, true);
    await merge('same-codec-copy', [files[0], files[0]], false);
  }
})().catch(error => { console.error('FAIL ' + (error.stderr ? String(error.stderr).slice(-1200) : error.message)); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
