/** 播放器全屏信息的纯格式化函数，便于单元测试。 */

export function formatClock(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatQualityMeta(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return '当前画面 等待视频信息';
  return `当前画面 ${Math.min(w, h)}P（${w} × ${h}）`;
}
