import assert from 'node:assert/strict';
import test from 'node:test';
import { formatClock, formatQualityMeta } from '../../playerDisplay.mjs';

test('clock uses a zero-padded 24 hour minute display', () => {
  assert.equal(formatClock(new Date(2026, 9, 25, 9, 5)), '09:05');
  assert.equal(formatClock(new Date(2026, 9, 25, 23, 59)), '23:59');
  assert.equal(formatClock(new Date(2026, 9, 25, 0, 0)), '00:00');
  assert.equal(formatClock('not-a-date'), '');
});

test('quality meta reports the shorter side and real pixels', () => {
  assert.equal(formatQualityMeta(1920, 1080), '当前画面 1080P（1920 × 1080）');
  assert.equal(formatQualityMeta(1280, 720), '当前画面 720P（1280 × 720）');
  assert.equal(formatQualityMeta(0, 0), '当前画面 等待视频信息');
  assert.equal(formatQualityMeta(undefined, 1080), '当前画面 等待视频信息');
});
