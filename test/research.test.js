// 主链路端到端：模拟扶摇路由 + 模拟大模型，跑 runResearch 全流程（零外网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch, validateInput } from '../src/research.js';
import { FuyaoClient } from '../src/fuyao.js';
import { LLMClient } from '../src/llm.js';
import { FAKE_KEY, makeFuyaoMock, makeLLMMock, weekdaysEnding } from './helpers.js';
import { bjDate } from '../src/util.js';

function setup({ llmMock = null } = {}) {
  const fm = makeFuyaoMock();
  const client = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: fm.baseUrl, fetchImpl: fm.fetch });
  const llm = llmMock
    ? new LLMClient({ apiKey: 'mock', baseUrl: llmMock.baseUrl, model: 'm', fetchImpl: llmMock.fetch })
    : new LLMClient({ apiKey: '', baseUrl: 'http://mock.llm', model: 'm' });
  return { fm, client, llm };
}
async function run(body, opts) {
  const { fm, client, llm } = setup(opts);
  const events = [];
  const report = await runResearch({ client, llm, input: validateInput(body), emit: (e) => events.push(e) });
  return { report, events, fm };
}

test('主链路（规则模式）：事件顺序 guard → plan → step… → report，报告字段齐全', async () => {
  const { report, events, fm } = await run({ index: '000001.SH', question: '现在市场是什么状态？' });
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'guard');
  const iPlan = types.indexOf('plan'), iStep = types.indexOf('step'), iReport = types.indexOf('report');
  assert.ok(iPlan > 0 && iStep > iPlan && iReport > iStep);
  assert.equal(iReport, types.length - 1, 'report 必须是最后一个事件');
  assert.equal(events.find((e) => e.type === 'step').tool, 'trading_calendar', '日历先执行');
  for (const k of ['regime', 'evidence', 'narrative', 'trace', 'stats', 'plan', 'gaps', 'charts', 'trade_date', 'disclaimer', 'regime_evidence']) assert.ok(report[k] !== undefined, `报告缺字段 ${k}`);
  assert.equal(report.trade_date, fm.lastDay);
  assert.equal(report.blocked, false);
  assert.equal(report.plan.planner, 'rules');
  assert.equal(report.narrative.source, 'template');
  assert.ok(report.regime.axes.trend && report.regime.axes.breadth && report.regime.axes.liquidity && report.regime.axes.sentiment);
  assert.ok(['高', '中', '低'].includes(report.regime.confidence.level));
  assert.ok(report.regime.switches.length > 0);
  // 每次调用都有轨迹，且全部打到模拟主机、携带的是假 Key
  assert.equal(report.stats.calls, report.trace.length);
  assert.ok(fm.calls.length > 0 && fm.calls.every((c) => c.key === FAKE_KEY));
  assert.ok(!JSON.stringify(report).includes(FAKE_KEY), '报告中不能出现 Key');
  // 资金面 2004 → 失败调用 + 缺口
  assert.equal(report.stats.failed, 2);
  assert.ok(report.gaps.some((g) => g.title === '成交额预测'));
  // 结论引用的证据都存在
  const ids = new Set([...report.evidence, ...report.regime_evidence].map((e) => e.id));
  for (const f of report.narrative.findings) for (const id of f.evidence) assert.ok(ids.has(id), `引用了不存在的证据 ${id}`);
});

test('主链路（模拟大模型）：模型规划 + 模型叙述，经校验后输出', async () => {
  const llmMock = makeLLMMock({
    plan: { intent: '全景研判', steps: [{ tool: 'trading_calendar', why: '定时点' }, { tool: 'index_history', why: '趋势' }, { tool: 'market_breadth', why: '宽度' }, { tool: 'limit_stats', why: '情绪' }] },
    narrate: (user) => {
      const T1 = user['证据'].find((e) => e.id === 'T1');
      const B1 = user['证据'].find((e) => e.id === 'B1');
      return {
        headline: '模型生成的标题', summary: '模型摘要。', answer: '模型回答。',
        findings: [
          { type: 'fact', text: `收盘点位：${T1['内容']}`, evidence: ['T1'] },
          { type: 'fact', text: `涨跌家数：${B1['内容']}`, evidence: ['B1'] },
          { type: 'inference', text: '综合状态以规则引擎判定为准。', evidence: ['R1'] },
          { type: 'uncertain', text: '主要矛盾仍需更多交易日确认。', evidence: ['R9'] },
        ],
        watch: [{ text: '关注趋势切换', evidence: ['C1'] }],
      };
    },
  });
  const { report, events } = await run({ index: '000300.SH' }, { llmMock });
  assert.equal(report.plan.planner, 'llm');
  assert.deepEqual(report.plan.steps.map((s) => s.tool), ['trading_calendar', 'index_history', 'market_breadth', 'limit_stats']);
  assert.equal(events.filter((e) => e.type === 'step' && e.status === 'running').length, 4, '只执行计划内的工具');
  assert.equal(report.narrative.source, 'llm');
  assert.equal(report.narrative.findings.length, 4);
  assert.equal(llmMock.calls.map((c) => c.kind).join(','), 'plan,narrate');
  // 计划外的维度如实记为缺口
  assert.ok(report.gaps.some((g) => g.dim === 'industry' && g.reason.includes('未纳入')));
});

test('合规：预测/建议类问题被识别、改写，流程继续但只研判状态', async () => {
  const { report, events } = await run({ question: '明天大盘会涨吗？现在该加仓吗？' });
  const guard = events.find((e) => e.type === 'guard').guard;
  assert.equal(guard.flagged, true);
  assert.deepEqual(guard.categories.sort(), ['投资建议', '涨跌预测'].sort());
  assert.ok(report.narrative.answer.includes('当前判断为'), '回答的是改写后的状态问题');
  assert.doesNotMatch(JSON.stringify(report.narrative), /建议(买入|加仓)|将上涨|将下跌/);
});

test('接口全挂（fuyao_down）：report.blocked=true，不输出研判结论', async () => {
  const { report, events } = await run({ simulate: ['fuyao_down'] });
  assert.equal(report.blocked, true);
  assert.equal(report.narrative.source, 'none');
  assert.equal(report.narrative.findings.length, 0);
  assert.match(report.narrative.headline, /不输出研判结论/);
  assert.equal(report.regime.name, '数据不足，无法判定');
  assert.equal(report.regime.confidence.level, '低');
  assert.equal(report.stats.failed, report.stats.calls);
  assert.ok(events.filter((e) => e.type === 'step').every((e) => e.status !== 'done'));
});

test('宽度缺失（breadth_missing）：宽度缺口出现在 gaps，状态名标注宽度未知', async () => {
  const { report } = await run({ simulate: ['breadth_missing'] });
  assert.equal(report.blocked, false);
  assert.ok(report.gaps.some((g) => g.dim === 'breadth' && g.reason.includes('故障演练')));
  assert.equal(report.regime.axes.breadth, undefined);
  assert.match(report.regime.name, /宽度未知/);
});

test('数据过期（stale）与数据冲突（conflict）：置信度下降并给出原因', async () => {
  const base = (await run({})).report;
  const stale = (await run({ simulate: ['stale'] })).report;
  assert.ok(stale.stale);
  assert.ok(stale.evidence.some((e) => e.status === 'stale'));
  assert.ok(stale.regime.confidence.value < base.regime.confidence.value);
  const conflict = (await run({ simulate: ['conflict'] })).report;
  assert.ok(conflict.evidence.some((e) => e.status === 'conflict'));
  assert.ok(conflict.regime.confidence.reasons.some((r) => r.text.startsWith('数据冲突')));
});

test('故障演练 llm_down：规划与叙述都降级为规则/模板，主链路照常完成', async () => {
  const llmMock = makeLLMMock({ plan: { steps: [] }, narrate: {} });
  const { report } = await run({ simulate: ['llm_down'] }, { llmMock });
  assert.equal(report.plan.planner, 'rules');
  assert.equal(report.narrative.source, 'template');
  assert.equal(llmMock.calls.length, 0, '演练时不应真的请求模型');
});

test('历史时点 asOf：快照类工具标记为 unavailable，不用最新值冒充', async () => {
  const days = weekdaysEnding(bjDate(Date.now() - 40 * 86400000), 1);
  const asOf = days[0];
  const { report, events } = await run({ asOf });
  assert.equal(report.input.asOf, asOf);
  assert.ok(report.trade_date <= asOf);
  const st = Object.fromEntries(events.filter((e) => e.type === 'step' && e.status !== 'running').map((e) => [e.tool, e.status]));
  for (const t of ['index_snapshot', 'market_breadth', 'valuation', 'news_flash']) assert.equal(st[t], 'unavailable', t);
  assert.ok(report.gaps.some((g) => g.dim === 'breadth' && g.reason.includes('只提供最新值')));
  assert.ok(report.charts.trend.bars.at(-1).d <= asOf, '日 K 不得包含研判时点之后的数据');
  assert.notEqual(report.regime.confidence.level, '高', '宽度缺失时完整度不足，不能给高置信度');
});

test('历史阶段追问：返回 3 个相似阶段及之后的情景区间，并附免责说明', async () => {
  const { report } = await run({ focus: 'history', index: '000300.SH' });
  assert.ok(report.analogs);
  assert.equal(report.analogs.items.length, 3);
  for (const a of report.analogs.items) {
    assert.ok(a.after.max_up >= a.after.end && a.after.max_down <= a.after.end);
    assert.ok(a.date < report.trade_date);
  }
  assert.match(report.analogs.caveat, /不代表未来/);
});

test('输入校验：非法日期 / 未来日期 / 超过一年 / 未知指数与追问方向', () => {
  assert.ok(validateInput({ asOf: '2026/01/01' }).error);
  assert.ok(validateInput({ asOf: bjDate(Date.now() + 3 * 86400000) }).error, '未来日期');
  assert.ok(validateInput({ asOf: bjDate(Date.now() - 400 * 86400000) }).error, '超过一年');
  const v = validateInput({ index: '999999.SH', focus: 'hack', simulate: ['fuyao_down', 'rm -rf'], question: 'x'.repeat(500) });
  assert.equal(v.index, '000001.SH');
  assert.equal(v.focus, 'overview');
  assert.deepEqual([...v.simulate], ['fuyao_down']);
  assert.equal(v.question.length, 200);
  assert.equal(validateInput({ asOf: bjDate(Date.now()) }).asOf, null, '今天等同于最新');
});
