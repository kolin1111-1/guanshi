// 指标与状态框架：用确定性构造数据验证标签、主要矛盾、置信度、切换条件与证据溯源
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeR, buildReport } from './helpers.js';
import { sanitize } from '../src/compliance.js';
import { templateNarrative } from '../src/narrator.js';

const NO_STYLE = ['000001.SH', '399001.SZ'];

test('上行 + 普涨 + 放量 + 情绪偏热：趋势上行·普涨扩散，置信度高，无突出矛盾', () => {
  const { R, ctx } = makeR({ shape: 'up', breadth: { upRatio: 0.8, upChg: 0.2, spread: 0 }, lastTurnover: () => 2e12 });
  const rep = buildReport(R, ctx);
  const A = rep.regime.axes;
  assert.equal(A.trend.label, '上行趋势');
  assert.equal(A.breadth.label, '扩散');
  assert.equal(A.liquidity.label, '放量');
  assert.equal(A.sentiment.label, '偏热');
  assert.equal(rep.regime.name, '趋势上行 · 普涨扩散');
  assert.equal(rep.regime.main_contradiction.tension, 0);
  assert.equal(rep.regime.confidence.level, '高');
});

test('下行趋势：标签、切换条件（含 MA 阈值、当前值、距离）', () => {
  const { R, ctx } = makeR({ shape: 'down', breadth: { upRatio: 0.2, upChg: 0.5, downChg: -1.5 }, lastTurnover: () => 1e11, limit: { up: 10, down: 60, seal: 0.4, opened: 20 } });
  const rep = buildReport(R, ctx);
  const A = rep.regime.axes;
  assert.equal(A.trend.label, '下行趋势');
  assert.equal(A.breadth.label, '收缩');
  assert.equal(A.liquidity.label, '缩量');
  assert.equal(A.sentiment.label, '偏冷');
  assert.equal(rep.regime.name, '趋势下行 · 普跌收缩');
  const sw = rep.regime.switches;
  const up = sw.find((s) => s.axis === '趋势' && s.to === '上行趋势');
  const toRange = sw.find((s) => s.axis === '趋势' && s.to === '震荡');
  assert.ok(up && toRange, '下行趋势应给出“转上行”与“转震荡”两个条件');
  assert.match(up.condition, /收盘站上 [\d,]+\.\d{2} 点/);
  assert.match(up.current, /点$/);
  assert.match(up.distance, /^[+-]\d+\.\d{2}%$/);
  for (const s of sw) {
    assert.ok(s.condition && s.current && s.distance, `切换条件字段不全：${JSON.stringify(s)}`);
    assert.ok(Array.isArray(s.evidence));
  }
  assert.ok(sw.some((s) => s.axis === '流动性' && s.to === '放量' && /亿元/.test(s.condition)), '流动性切换阈值要带金额单位');
  assert.ok(!sw.some((s) => s.axis === '趋势' && s.to === '下行趋势'), '不能给出切换到当前状态本身的条件');
});

test('震荡：趋势分落在 (-1, 1) 区间', () => {
  const { R, ctx } = makeR({ shape: 'range' });
  const rep = buildReport(R, ctx);
  assert.equal(rep.regime.axes.trend.label, '震荡');
  assert.ok(Math.abs(rep.regime.axes.trend.score) < 1);
});

test('主要矛盾：指数上行但多数个股下跌 → 识别为背离，并扣减置信度', () => {
  const base = buildReport(...Object.values(makeR({ shape: 'up', breadth: { upRatio: 0.8, upChg: 0.2, spread: 0 }, lastTurnover: () => 2e12 })));
  const { R, ctx } = makeR({ shape: 'up', breadth: { upRatio: 0.25, upChg: 0.5, downChg: -1.5 }, lastTurnover: () => 2e12 });
  const rep = buildReport(R, ctx);
  assert.equal(rep.regime.name, '指数上行 · 宽度背离');
  assert.match(rep.regime.main_contradiction.text, /背离/);
  assert.ok(rep.regime.main_contradiction.tension >= 1);
  assert.ok(rep.regime.main_contradiction.evidence.length > 0, '主要矛盾必须引用证据');
  assert.ok(rep.regime.confidence.value < base.regime.confidence.value, '有矛盾时置信度应低于各维同向的情形');
  assert.ok(rep.regime.confidence.reasons.some((r) => r.text.includes('主要矛盾')));
});

test('主要矛盾：情绪“中性”时不能被说成“题材活跃”（回归：封板率 44.7% 的真实案例）', () => {
  const { R, ctx } = makeR({ shape: 'down', breadth: { upRatio: 0.35 }, limit: { up: 55, down: 4, seal: 0.447, opened: 68 } });
  const rep = buildReport(R, ctx);
  assert.equal(rep.regime.axes.sentiment.label, '中性');
  assert.doesNotMatch(rep.regime.main_contradiction.text, /情绪偏活跃|题材与指数脱节/);
});

test('置信度：数据完整度 < 80% 时即使得分 ≥0.8 也只能是「中」', () => {
  // 只有趋势 + 宽度 + 情绪（无风格、无流动性）→ 完整度 0.7，方向全部一致
  const { R, ctx } = makeR({ shape: 'up', codes: ['000001.SH'], breadth: { upRatio: 0.8 } });
  const rep = buildReport(R, ctx);
  const c = rep.regime.confidence;
  assert.ok(c.value >= 0.8, `构造用例的得分应 ≥0.8，实际 ${c.value}`);
  assert.equal(c.level, '中');
  assert.ok(c.reasons.some((r) => r.text.includes('上限为「中」')));
});

test('数据缺失：宽度接口失败 → 出现缺口证据（含失败原因），不生成宽度标签，置信度下降', () => {
  const full = buildReport(...Object.values(makeR({ shape: 'up' })));
  const { R, ctx } = makeR({ shape: 'up', breadth: false });
  const rep = buildReport(R, ctx);
  assert.equal(rep.regime.axes.breadth, undefined);
  const g = rep.gaps.find((x) => x.dim === 'breadth');
  assert.ok(g, '宽度缺口必须出现在 gaps');
  assert.match(g.reason, /code=5003/);
  const ge = rep.evidence.find((e) => e.kind === 'gap' && e.dim === 'breadth');
  assert.equal(ge.status, 'missing');
  assert.ok(rep.regime.confidence.value < full.regime.confidence.value);
  assert.match(rep.regime.name, /宽度未知/);
});

test('资金面接口 2004：作为两个缺口展示，而不是静默忽略', () => {
  const { R, ctx } = makeR({ shape: 'up' });
  const rep = buildReport(R, ctx);
  const titles = rep.gaps.map((g) => g.title);
  assert.ok(titles.includes('成交额预测'));
  assert.ok(titles.includes('宽基 ETF 净申购'));
  assert.ok(rep.gaps.every((g) => g.reason.includes('2004') || g.dim !== 'liquidity'));
});

test('核心数据缺失：指数日 K 失败 → 无趋势轴、状态为“数据不足”，主要矛盾不得声称“各维度一致”', () => {
  const { R, ctx } = makeR({ shape: 'up', breadth: false, limit: null, capitalFlows: false });
  R.index_history = { ok: false, provs: [{ tool: 'index_history', endpoint: '/x', status: 'error', code: 'SIMULATED', message: '故障演练：模拟接口失败' }] };
  const rep = buildReport(R, ctx);
  assert.equal(rep.regime.axes.trend, undefined);
  assert.equal(rep.regime.name, '数据不足，无法判定');
  assert.doesNotMatch(rep.regime.main_contradiction.text, /大体一致/);
  assert.equal(rep.regime.confidence.level, '低');
});

test('数据冲突：快照与日 K 同日收盘相差 >0.3% → 冲突证据 + 置信度扣分', () => {
  const ok = makeR({ shape: 'up' });
  const okRep = buildReport(ok.R, ok.ctx);
  const close = ok.R.index_history.data.series['000001.SH'].at(-1).c;
  const { R, ctx } = makeR({ shape: 'up', snapshot: { '000001.SH': { last_price: close * 1.02, price_change_ratio_pct: 1 }, '000300.SH': { last_price: 1, price_change_ratio_pct: 0.5 } } });
  const rep = buildReport(R, ctx);
  const q = rep.evidence.find((e) => e.status === 'conflict');
  assert.ok(q, '应产生冲突证据');
  assert.match(q.display, /相差 2\.00%/);
  assert.ok(rep.regime.confidence.reasons.some((r) => r.text.startsWith('数据冲突')));
  assert.ok(rep.regime.confidence.value <= okRep.regime.confidence.value - 0.09);
});

test('数据过期：stale 时置信度下降并写明原因', () => {
  const { R, ctx } = makeR({ shape: 'up' });
  const fresh = buildReport(R, ctx);
  const stale = buildReport(R, ctx, { stale: '指数日 K 最新为 2026-11-17，研判交易日为 2026-11-20' });
  assert.ok(stale.regime.confidence.value < fresh.regime.confidence.value);
  assert.ok(stale.regime.confidence.reasons.some((r) => r.text.includes('数据时点过期')));
});

test('宽度：直方图各桶之和 = 有效样本数（停牌股被剔除）', () => {
  const { R, ctx } = makeR({ shape: 'up', breadth: { n: 1000, upRatio: 0.6, flat: 10, suspended: 7 } });
  const rep = buildReport(R, ctx);
  const sum = rep.charts.breadth.reduce((s, b) => s + b.n, 0);
  const M = rep.metrics;
  assert.equal(sum, M.up + M.down + M.flat);
  assert.equal(sum, 1000, '7 只停牌（volume=0）必须被剔除');
  assert.equal(M.flat, 10);
  assert.equal(rep.charts.breadth.find((b) => b.label === '0').n, 10);
});

test('证据溯源：每条非缺口证据都带来源工具、端点、时点、口径', () => {
  const { R, ctx } = makeR({ shape: 'up' });
  const rep = buildReport(R, ctx);
  for (const e of rep.evidence.filter((x) => x.kind !== 'gap')) {
    assert.ok(e.id && e.label && e.display, `证据字段不全：${e.id}`);
    assert.ok(e.source?.tool, `${e.id} 缺来源工具`);
    assert.ok(e.source.endpoints.length > 0, `${e.id} 缺端点`);
    assert.ok(e.as_of, `${e.id} 缺时点`);
    assert.ok(e.method, `${e.id} 缺口径说明`);
  }
  const ids = rep.evidence.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, '证据 ID 不能重复');
});

test('流动性：两市成交额 = 上证指数 + 深证成指 turnover，单位换算为亿元', () => {
  const { R, ctx } = makeR({ shape: 'up', lastTurnover: (code) => (code === '399001.SZ' ? 9e11 : 8e11) });
  const rep = buildReport(R, ctx);
  const L1 = rep.evidence.find((e) => e.label === '沪深两市成交额');
  assert.equal(L1.value, 17000);
  assert.equal(L1.unit, '亿元');
  assert.match(L1.display, /^17,000 亿元/);
});

test('模板叙述：三类结论齐全、全部引用证据、且自身不触发合规拦截', () => {
  for (const shape of ['up', 'down', 'range']) {
    const { R, ctx } = makeR({ shape });
    const rep = buildReport(R, ctx);
    const n = templateNarrative(rep);
    const types = new Set(n.findings.map((f) => f.type));
    assert.ok(types.has('fact') && types.has('inference') && types.has('uncertain'), `${shape}: ${[...types]}`);
    for (const f of n.findings) {
      assert.ok(f.evidence.length > 0);
      assert.equal(sanitize(f.text).violations.length, 0, `模板文本被拦截：${f.text}`);
    }
    assert.equal(sanitize(n.summary).violations.length, 0);
    assert.equal(sanitize(n.answer).violations.length, 0, n.answer);
  }
});
