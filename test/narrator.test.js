// 研判叙述：数字核对、引用校验、合规拦截、降级（全部使用模拟大模型）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyNumbers, narrate, regimeEvidence } from '../src/narrator.js';
import { LLMClient } from '../src/llm.js';
import { makeR, buildReport, makeLLMMock, hangingFetch } from './helpers.js';

const ev = (display, label = '测试证据', value = null) => ({ id: 'X1', label, display, value });

test('verifyNumbers：与证据一致（含千分位、四舍五入、正负号）的数字通过', () => {
  const cited = [ev('3,548.37 点，当日 +0.27%'), ev('近 20 日 中证1000 -9.77% vs 沪深300 -2.12%（差 -7.66 个百分点）')];
  assert.deepEqual(verifyNumbers('上证收盘 3548.37 点，当日 +0.27%', cited), []);
  assert.deepEqual(verifyNumbers('收盘约 3,548.4 点', cited), [], '保留 1 位小数的四舍五入应通过');
  assert.deepEqual(verifyNumbers('沪深300 跑赢中证1000 7.66 个百分点', cited), [], '取绝对值复述应通过');
  assert.deepEqual(verifyNumbers('近 20 日、60 日与 250 日窗口', cited), [], '窗口长度属于口径数字');
  assert.deepEqual(verifyNumbers('沪深300（000300）', cited), [], '六位证券代码不算数值');
});

test('verifyNumbers：证据里没有的数字被拒绝', () => {
  const cited = [ev('3,548.37 点，当日 +0.27%')];
  assert.deepEqual(verifyNumbers('上证收盘 3600 点', cited), ['3600']);
  assert.deepEqual(verifyNumbers('成交额 2.5 万亿元', cited), ['2.5']);
  assert.deepEqual(verifyNumbers('上涨占比 61.3%', cited), ['61.3']);
});

function baseReport() {
  const { R, ctx } = makeR({ shape: 'down', breadth: { upRatio: 0.35 } });
  return buildReport(R, ctx, { question: '现在市场是什么状态？' });
}

/** 按收到的证据动态构造一份“好坏参半”的模型输出 */
function mixedOutput(user) {
  const list = user['证据'];
  const T1 = list.find((e) => e.id === 'T1');
  const gap = list.find((e) => e.id.startsWith('G'));
  return {
    headline: '下行趋势中的结构分化',
    summary: '多项证据指向偏弱的市场状态。',
    findings: [
      { type: 'fact', text: `收盘点位：${T1['内容']}`, evidence: ['T1'] }, // 通过
      { type: 'inference', text: '综合状态由规则引擎给出，本段只做解释。', evidence: ['R1'] }, // 通过
      { type: 'uncertain', text: '资金面数据缺失，判断不完整。', evidence: [gap.id] }, // 通过（缺口只能写成不确定）
      { type: 'inference', text: '综合来看市场偏弱，预计将继续下跌。', evidence: ['R1'] }, // 通过校验但被合规替换
      { type: 'fact', text: '上证收盘 9999.99 点', evidence: ['T1'] }, // 数字对不上 → 剔除
      { type: 'fact', text: '某条不存在的证据', evidence: ['X99'] }, // 无效 ID → 剔除
      { type: 'fact', text: '资金面已确认流出', evidence: [gap.id] }, // 用缺失证据写确定结论 → 剔除
    ],
    answer: '当前判断以规则引擎为准，请关注切换条件。',
    watch: [{ text: '跟踪趋势切换条件', evidence: ['C1'] }, { text: '无效引用', evidence: ['C99'] }],
  };
}

test('narrate：三道校验——无效引用 / 数字不符 / 缺失证据写成事实 被剔除，违规句被替换', async () => {
  const mock = makeLLMMock({ narrate: mixedOutput });
  const llm = new LLMClient({ apiKey: 'mock', baseUrl: mock.baseUrl, model: 'm', fetchImpl: mock.fetch });
  const n = await narrate({ llm, report: baseReport(), simulate: new Set() });
  assert.equal(n.source, 'llm');
  assert.equal(n.findings.length, 4);
  assert.equal(n.validation.checked, 7);
  assert.equal(n.validation.passed, 4);
  const reasons = n.validation.dropped.map((d) => d.reason).join('|');
  assert.match(reasons, /9999\.99/);
  assert.match(reasons, /未引用任何有效证据/);
  assert.match(reasons, /缺失状态/);
  assert.ok(n.validation.violations.length >= 1);
  assert.ok(n.findings.some((f) => f.text.includes('〔已拦截')), '违规句应被替换');
  assert.ok(!n.findings.some((f) => /将继续下跌/.test(f.text)));
  assert.equal(n.watch.length, 1, '无效引用的跟踪项被丢弃');
  // 发给模型的证据中不应出现 API Key
  assert.ok(!JSON.stringify(mock.calls).includes('X-api-key'));
});

test('narrate：通过校验的结论不足 3 条 → 降级为模板，并写明原因', async () => {
  const mock = makeLLMMock({ narrate: () => ({ headline: 'x', summary: 'y', findings: [{ type: 'fact', text: '上证收盘 1.23 点', evidence: ['T1'] }, { type: 'fact', text: 'z', evidence: ['NOPE'] }], answer: 'a', watch: [] }) });
  const llm = new LLMClient({ apiKey: 'mock', baseUrl: mock.baseUrl, model: 'm', fetchImpl: mock.fetch });
  const n = await narrate({ llm, report: baseReport(), simulate: new Set() });
  assert.equal(n.source, 'template');
  assert.match(n.fallback_reason, /不足 3 条/);
  assert.ok(n.findings.length >= 3);
});

test('narrate：摘要或回答里有无法核对的数字 → 换成模板摘要/回答', async () => {
  const mock = makeLLMMock({ narrate: (user) => ({ ...mixedOutput(user), summary: '成交额 876543.2 亿元，创纪录。', answer: '上证收盘 98765.4 点附近。' }) });
  const llm = new LLMClient({ apiKey: 'mock', baseUrl: mock.baseUrl, model: 'm', fetchImpl: mock.fetch });
  const rep = baseReport();
  const n = await narrate({ llm, report: rep, simulate: new Set() });
  assert.doesNotMatch(n.summary, /9\.9 万亿/);
  assert.doesNotMatch(n.answer, /98765/);
  assert.ok(n.validation.dropped.some((d) => d.reason.includes('回答')));
  assert.ok(n.validation.dropped.some((d) => d.reason.includes('摘要')));
});

test('narrate：模型余额不足（402）→ 降级为模板，fallback_reason 说明原因', async () => {
  const mock = makeLLMMock({ status: 402 });
  const llm = new LLMClient({ apiKey: 'mock', baseUrl: mock.baseUrl, model: 'm', fetchImpl: mock.fetch });
  const n = await narrate({ llm, report: baseReport(), simulate: new Set() });
  assert.equal(n.source, 'template');
  assert.match(n.fallback_reason, /余额不足/);
  assert.equal(llm.lastStatus.ok, false);
});

test('narrate：模型超时 → 降级为模板', async () => {
  const llm = new LLMClient({ apiKey: 'mock', baseUrl: 'http://mock.llm', model: 'm', fetchImpl: hangingFetch(), timeoutMs: 40 });
  const n = await narrate({ llm, report: baseReport(), simulate: new Set() });
  assert.equal(n.source, 'template');
  assert.match(n.fallback_reason, /超时/);
});

test('narrate：模型输出非 JSON / 未配置 Key / 故障演练 llm_down → 均降级为模板', async () => {
  const bad = makeLLMMock({ narrate: null });
  const n1 = await narrate({ llm: new LLMClient({ apiKey: 'mock', baseUrl: bad.baseUrl, model: 'm', fetchImpl: bad.fetch }), report: baseReport(), simulate: new Set() });
  assert.match(n1.fallback_reason, /JSON/);
  const n2 = await narrate({ llm: new LLMClient({ apiKey: '', baseUrl: 'http://mock.llm', model: 'm', fetchImpl: () => { throw new Error('不应调用'); } }), report: baseReport(), simulate: new Set() });
  assert.match(n2.fallback_reason, /LLM_API_KEY/);
  const n3 = await narrate({ llm: new LLMClient({ apiKey: 'mock', baseUrl: 'http://mock.llm', model: 'm', fetchImpl: () => { throw new Error('不应调用'); } }), report: baseReport(), simulate: new Set(['llm_down']) });
  assert.match(n3.fallback_reason, /故障演练/);
});

test('regimeEvidence：规则判定与切换条件被编号为 R/C 证据，可被引用与核对', () => {
  const rep = baseReport();
  const list = regimeEvidence(rep.regime);
  assert.equal(list[0].id, 'R1');
  assert.ok(list.some((e) => e.id === 'R9' && e.display === rep.regime.main_contradiction.text));
  assert.equal(list.filter((e) => e.id.startsWith('C')).length, rep.regime.switches.length);
  const ids = list.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});
