// 研判主链路编排：合规预检 → 取数计划 → 调用工具 → 证据 → 状态框架 → 叙述与校验 → 报告
// 通过 emit 回调把每一步实时推给前端（NDJSON 流）。
import { TOOLS, INDEX_NAMES, TARGET_INDEXES } from './tools.js';
import { buildEvidence } from './indicators.js';
import { classify } from './regime.js';
import { makePlan, FOCUS } from './planner.js';
import { narrate, regimeEvidence } from './narrator.js';
import { checkQuestion, DISCLAIMER } from './compliance.js';
import { findAnalogs } from './analogs.js';
import { pool, bjDate, bjDateTime } from './util.js';

export const SIMULATIONS = {
  fuyao_down: '扶摇接口全部失败',
  fuyao_timeout: '扶摇接口超时',
  breadth_missing: '全市场快照失败（宽度缺失）',
  llm_down: '大模型不可用',
  stale: '数据过期（时点滞后）',
  conflict: '快照与日 K 数据冲突',
};

export function validateInput(body = {}) {
  const index = TARGET_INDEXES.includes(body.index) ? body.index : '000001.SH';
  const focus = FOCUS[body.focus] ? body.focus : 'overview';
  const question = String(body.question || '').slice(0, 200);
  let asOf = null;
  if (body.asOf) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.asOf)) return { error: '日期格式应为 YYYY-MM-DD' };
    const today = bjDate(Date.now());
    if (body.asOf > today) return { error: '研判时点不能晚于今天（本产品不做未来预测）' };
    const min = bjDate(Date.now() - 360 * 86400000);
    if (body.asOf < min) return { error: `历史时点最早支持 ${min}（涨跌停等数据只保留一年）` };
    if (body.asOf !== today) asOf = body.asOf;
  }
  const simulate = new Set((Array.isArray(body.simulate) ? body.simulate : []).filter((s) => SIMULATIONS[s]));
  return { index, focus, question, asOf, simulate };
}

export async function runResearch({ client, llm, input, emit = () => {} }) {
  const t0 = Date.now();
  const { index, focus, question, asOf, simulate } = input;
  const trace = [];
  const ctx = { client, index, asOf, simulate, callCtx: { simulate, trace } };
  const report = {
    id: `R${Date.now().toString(36)}`,
    created_at: Date.now(),
    input: { question, index, indexName: INDEX_NAMES[index], asOf, focus, focusName: FOCUS[focus], simulate: [...simulate] },
    disclaimer: DISCLAIMER,
  };

  // 1. 合规预检
  const guard = checkQuestion(question);
  report.guard = guard;
  emit({ type: 'guard', guard });

  // 2. 取数计划
  emit({ type: 'stage', key: 'plan', text: llm.configured && !simulate.has('llm_down') ? '大模型正在制定取数计划…' : '按规则制定取数计划…' });
  const plan = await makePlan({ llm, question: guard.flagged ? guard.reframed : question, focus, index, asOf, simulate });
  report.plan = plan;
  emit({ type: 'plan', plan });

  // 3. 执行：日历先行，其余并发
  const R = {};
  const runStep = async (step) => {
    emit({ type: 'step', tool: step.tool, status: 'running' });
    const before = trace.length;
    let r;
    try { r = await TOOLS[step.tool].run(ctx); } catch (e) { r = { ok: false, provs: [], error: String(e?.message || e) }; }
    R[step.tool] = r;
    const provs = trace.slice(before);
    emit({ type: 'step', tool: step.tool, status: r.ok ? 'done' : r.unavailable ? 'unavailable' : 'error', calls: (r.provs || []).length, failed: (r.provs || []).filter((p) => p.status === 'error').length, note: r.unavailable ? r.reason : r.ok ? null : ((r.provs || []).find((p) => p.status === 'error')?.message || r.error || '失败'), latency_ms: provs.reduce((m, p) => Math.max(m, p.latency_ms), 0) });
  };
  await runStep(plan.steps[0]);
  const cal = R.trading_calendar?.ok ? R.trading_calendar.data.days : [];
  ctx.calendar = cal;
  const bjNow = Date.now() + 8 * 3600000;
  const todayStr = bjDate(Date.now());
  const minutes = new Date(bjNow).getUTCHours() * 60 + new Date(bjNow).getUTCMinutes();
  let tradeDate = asOf ? cal.filter((d) => d <= asOf).at(-1) : cal.filter((d) => d < todayStr || (d === todayStr && minutes >= 9 * 60 + 25)).at(-1);
  if (!tradeDate) tradeDate = asOf || (minutes >= 9 * 60 + 25 ? todayStr : bjDate(Date.now() - 86400000)); // 日历失败时按自然日推断，并在数据质量中提示
  ctx.tradeDate = tradeDate;
  report.trade_date = tradeDate;
  emit({ type: 'stage', key: 'fetch', text: `研判交易日 ${tradeDate}，开始取数（${plan.steps.length - 1} 个工具）…` });
  await pool(plan.steps.slice(1), 3, runStep);

  // 4. 证据
  emit({ type: 'stage', key: 'evidence', text: '计算指标、核对口径与冲突…' });
  const built = buildEvidence(R, ctx);
  let stale = null;
  const lastBar = R.index_history?.ok ? R.index_history.data.series[index]?.at(-1)?.d : null;
  if (simulate.has('stale')) stale = `故障演练：数据最新日期被视为 ${cal.at(-4) || '3 个交易日前'}，晚于研判交易日 ${tradeDate}`;
  else if (lastBar && lastBar < tradeDate && !R.index_snapshot?.ok) stale = `指数日 K 最新为 ${lastBar}，研判交易日为 ${tradeDate}`;
  if (!R.trading_calendar?.ok) built.evidence.push({ id: 'Q9', dim: 'quality', kind: 'gap', status: 'missing', label: '交易日历', display: '交易日历获取失败，研判时点按自然日推断，可能不准确', source: { tool: 'trading_calendar', endpoints: [], request_ids: [], fields: [] }, method: '' });
  const dataTimes = trace.filter((p) => p.status === 'ok' && p.data_timestamp).map((p) => p.data_timestamp);
  report.data_time = dataTimes.length ? bjDateTime(Math.max(...dataTimes)) : null;
  report.stale = stale;
  if (stale) built.evidence.push({ id: 'Q8', dim: 'quality', kind: 'fact', status: 'stale', label: '数据时点滞后', display: stale, source: { tool: 'index_history', endpoints: [], request_ids: [], fields: ['date_ms'] }, method: '数据最新日期早于研判交易日即视为过期；过期时降低置信度并在页面置顶提示' });
  Object.assign(report, { evidence: built.evidence, metrics: built.metrics, charts: built.charts, gaps: built.gaps });

  // 5. 状态框架
  emit({ type: 'stage', key: 'regime', text: '规则引擎判定市场状态…' });
  report.regime = classify({ metrics: built.metrics, evidence: built.evidence, gaps: built.gaps, ctx, stale });
  report.regime_evidence = regimeEvidence(report.regime);
  report.blocked = !report.regime.axes.trend; // 核心数据缺失：不输出研判结论
  if (focus === 'history' && R.index_history_long?.ok) report.analogs = findAnalogs(R.index_history_long.data.bars);

  // 6. 叙述
  if (report.blocked) {
    report.narrative = {
      source: 'none',
      headline: '核心数据获取失败，本次不输出研判结论',
      summary: `指数日 K 不可用（${built.gaps.find((g) => g.dim === 'trend')?.reason || '未知原因'}）。为避免生成看似正常的结论，本次只展示调用记录与可用的零散事实。`,
      findings: [],
      answer: '请稍后重试，或查看右侧调用轨迹了解失败原因。',
      watch: [],
    };
  } else {
    emit({ type: 'stage', key: 'narrate', text: llm.configured && !simulate.has('llm_down') ? '大模型基于证据撰写结论，并逐条校验引用与数字…' : '生成模板结论…' });
    report.narrative = await narrate({ llm, report, simulate });
  }

  report.trace = trace.map(({ params, url_no_key, ...p }) => ({ ...p, params }));
  report.stats = { calls: trace.length, failed: trace.filter((p) => p.status === 'error').length, cached: trace.filter((p) => p.cached).length, elapsed_ms: Date.now() - t0 };
  emit({ type: 'report', report });
  return report;
}
