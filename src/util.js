// 通用工具：北京时间日期、统计、格式化
export const DAY = 86400000;
const BJ = 8 * 3600000;

/** 毫秒时间戳 → 北京时间 YYYY-MM-DD */
export function bjDate(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms + BJ).toISOString().slice(0, 10);
}
/** 毫秒时间戳 → 北京时间 YYYY-MM-DD HH:mm */
export function bjDateTime(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms + BJ).toISOString().slice(0, 16).replace('T', ' ');
}
/** YYYY-MM-DD / YYYYMMDD → 北京时间当日零点毫秒 */
export function bjMidnight(d) {
  const s = String(d).replace(/-/g, '');
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) - BJ;
}

export const sum = (a) => a.reduce((x, y) => x + y, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : null);
export function median(a) {
  const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
export function std(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1));
}
/** v 在数组中的分位（0~1，含等于） */
export function pctRank(arr, v) {
  const a = arr.filter(Number.isFinite);
  if (!a.length || !Number.isFinite(v)) return null;
  return a.filter((x) => x <= v).length / a.length;
}
/** 数组第 p 分位的值（线性插值） */
export function quantile(arr, p) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
/** 简单移动平均，返回最后一个值 */
export function smaLast(a, n) {
  if (a.length < n) return null;
  return mean(a.slice(-n));
}
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const ret = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? (a / b - 1) * 100 : null);

// ---- 格式化（全部带单位，避免口径歧义）----
export function fmtNum(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export const fmtPct = (v, d = 2, sign = true) =>
  v == null || !Number.isFinite(v) ? '—' : `${sign && v > 0 ? '+' : ''}${v.toFixed(d)}%`;
export const fmtYi = (yuan, d = 0) => (yuan == null || !Number.isFinite(yuan) ? '—' : `${fmtNum(yuan / 1e8, d)} 亿元`);
export const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** 有限并发执行 */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
