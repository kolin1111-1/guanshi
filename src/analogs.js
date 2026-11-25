// 历史阶段对比：在目标指数近 5 年日 K 中寻找与当前「特征向量」最相似的时点。
// 特征：60 日涨跌、20 日年化波动、250 日区间位置、成交额相对 250 日均值。
// 只展示「之后 20 个交易日的最大涨幅/最大回撤区间」，强调情景分布而非方向预测。
import { mean, std, ret, round, fmtPct, fmtNum } from './util.js';

function features(bars, i) {
  if (i < 250) return null;
  const c = bars.map((b) => b.c);
  const r60 = ret(c[i], c[i - 60]);
  const lr = [];
  for (let k = i - 19; k <= i; k++) lr.push(Math.log(c[k] / c[k - 1]));
  const vol = std(lr) * Math.sqrt(252) * 100;
  const w = c.slice(i - 249, i + 1);
  const hi = Math.max(...w), lo = Math.min(...w);
  const pos = hi > lo ? ((c[i] - lo) / (hi - lo)) * 100 : 50;
  const tv = bars.slice(i - 249, i + 1).map((b) => b.t);
  const tvr = bars[i].t / mean(tv);
  return [r60, vol, pos, tvr];
}

export function findAnalogs(bars, { k = 3, horizon = 20, gap = 40 } = {}) {
  if (!bars || bars.length < 320) return { items: [], note: `历史样本不足（${bars?.length || 0} 根日 K）` };
  const n = bars.length;
  const cur = features(bars, n - 1);
  const rows = [];
  for (let i = 250; i < n - 1 - Math.max(horizon, 60); i++) {
    const f = features(bars, i);
    if (f) rows.push({ i, f });
  }
  // 标准化
  const mu = [0, 1, 2, 3].map((j) => mean(rows.map((r) => r.f[j])));
  const sd = [0, 1, 2, 3].map((j) => std(rows.map((r) => r.f[j])) || 1);
  const z = (f) => f.map((x, j) => (x - mu[j]) / sd[j]);
  const zc = z(cur);
  for (const r of rows) r.dist = Math.sqrt(z(r.f).reduce((s, x, j) => s + (x - zc[j]) ** 2, 0));
  rows.sort((a, b) => a.dist - b.dist);
  const picked = [];
  for (const r of rows) {
    if (picked.every((p) => Math.abs(p.i - r.i) >= gap)) picked.push(r);
    if (picked.length >= k) break;
  }
  const fmtF = (f) => `60 日 ${fmtPct(f[0], 1)}，波动率 ${fmtNum(f[1], 1)}%，区间位置 ${fmtNum(f[2], 0)}%，成交额/年均 ${fmtNum(f[3], 2)} 倍`;
  const items = picked.map((p) => {
    const base = bars[p.i].c;
    const fut = bars.slice(p.i + 1, p.i + 1 + horizon).map((b) => b.c);
    const maxUp = (Math.max(...fut) / base - 1) * 100;
    const maxDn = (Math.min(...fut) / base - 1) * 100;
    const end = (fut.at(-1) / base - 1) * 100;
    return {
      date: bars[p.i].d,
      similarity: round(1 / (1 + p.dist), 3),
      features: p.f.map((x) => round(x, 2)),
      features_text: fmtF(p.f),
      after: { max_up: round(maxUp, 2), max_down: round(maxDn, 2), end: round(end, 2) },
      after_text: `之后 ${horizon} 个交易日区间：最高 ${fmtPct(maxUp, 1)}，最低 ${fmtPct(maxDn, 1)}，期末 ${fmtPct(end, 1)}`,
      path: bars.slice(Math.max(0, p.i - 60), p.i + 1 + horizon).map((b) => ({ d: b.d, c: b.c })),
    };
  });
  return {
    current: { date: bars.at(-1).d, features: cur.map((x) => round(x, 2)), features_text: fmtF(cur) },
    items,
    method: '特征 = [60 日涨跌, 20 日年化波动率, 250 日区间位置, 当日成交额/250 日均值]，各自标准化后取欧氏距离最近的 3 个时点（彼此间隔 ≥40 个交易日，排除最近 60 个交易日）',
    caveat: '历史相似不代表未来重演；这里展示的是历史上相似状态之后出现过的情景区间，不是对未来方向的预测。',
  };
}
