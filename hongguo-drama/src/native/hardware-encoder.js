const { spawn } = require('node:child_process');

const HARDWARE_ENCODERS = [
  ...(process.platform === 'darwin' ? ['h264_videotoolbox'] : []),
  'h264_nvenc',
  'h264_qsv',
  'h264_amf',
];

/**
 * Build FFmpeg/LibreMpeg arguments for the selected H.264 hardware encoder.
 */
function hardwareEncoderArgs(encoder) {
  if (encoder === 'h264_videotoolbox') {
    return ['-c:v', 'h264_videotoolbox', '-allow_sw', '0', '-realtime', '0', '-q:v', '68', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-threads:v', '2'];
  }
  if (encoder === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-profile:v', 'high', '-preset', 'p2', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-pix_fmt', 'yuv420p'];
  }
  if (encoder === 'h264_qsv') {
    return ['-c:v', 'h264_qsv', '-profile:v', 'high', '-preset', 'veryfast', '-global_quality', '23', '-pix_fmt', 'yuv420p'];
  }
  if (encoder === 'h264_amf') {
    return ['-c:v', 'h264_amf', '-profile:v', 'high', '-quality', 'speed', '-rc', 'vbr_peak', '-qmin', '19', '-qmax', '26', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-threads:v', '2', '-x264-params', 'lookahead_threads=1'];
}

function runProbe(executable, args, { signal, cancelToken, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted || cancelToken?.reason) return resolve({ ok: false, stdout: '' });
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ ok: false, stdout: '' });
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', stop);
      cancelToken?.unsubscribe?.(stop);
    };
    const timer = setTimeout(stop, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', stop, { once: true });
    cancelToken?.subscribe?.(stop);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ ok: code === 0, stdout });
    });
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ ok: false, stdout: '' });
    });
  });
}

/**
 * Pick the first working H.264 hardware encoder supported by `executable`, or `{ encoder: null }`.
 */
async function pickHardwareEncoder({ executable, signal, cancelToken } = {}) {
  if (!executable || signal?.aborted || cancelToken?.reason) return { encoder: null };
  const listRes = await runProbe(executable, ['-hide_banner', '-encoders'], { signal, cancelToken, timeoutMs: 3000 });
  if (!listRes.stdout) return { encoder: null };
  const candidates = HARDWARE_ENCODERS.filter((enc) => listRes.stdout.includes(enc));
  for (const encoder of candidates) {
    if (signal?.aborted || cancelToken?.reason) return { encoder: null };
    const testRes = await runProbe(executable, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=black:s=128x128:d=0.1',
      '-frames:v', '1', ...hardwareEncoderArgs(encoder), '-f', 'null', '-',
    ], { signal, cancelToken, timeoutMs: 4000 });
    if (testRes.ok) return { encoder };
  }
  return { encoder: null };
}

module.exports = { pickHardwareEncoder, hardwareEncoderArgs };
