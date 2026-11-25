// 取数计划：规则规划、模型规划的白名单校验与必需工具补全、降级
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulePlan, makePlan, FOCUS } from '../src/planner.js';
import { TOOLS } from '../src/tools.js';
import { LLMClient } from '../src/llm.js';
import { makeLLMMock } from './helpers.js';

const llmWith = (plan) => { const m = makeLLMMock({ plan }); return { llm: new LLMClient({ apiKey: 'mock', baseUrl: m.baseUrl, model: 'm', fetchImpl: m.fetch }), mock: m }; };

test('规则规划：日历第一、包含必需工具、只含已注册工具、每步有理由', () => {
  for (const focus of Object.keys(FOCUS)) {
    const p = rulePlan({ focus });
    assert.equal(p.steps[0].tool, 'trading_calendar', focus);
    assert.ok(p.steps.some((s) => s.tool === 'index_history'), focus);
    for (const s of p.steps) {
      assert.ok(TOOLS[s.tool], `未注册工具 ${s.tool}`);
      assert.ok(s.why, `${s.tool} 缺理由`);
    }
    assert.equal(new Set(p.steps.map((s) => s.tool)).size, p.steps.length, '不能重复');
    assert.ok(p.steps.length <= 12);
  }
});

test('规则规划：全景研判覆盖八类证据对应的工具', () => {
  const tools = rulePlan({ focus: 'overview' }).steps.map((s) => s.tool);
  for (const t of ['index_history', 'market_breadth', 'industry_board', 'valuation', 'limit_stats', 'news_flash', 'capital_flows']) assert.ok(tools.includes(t), t);
});

test('规则规划：问题关键词会追加相关工具（行业追问 + 问估值 → 加估值；风格追问 + 问历史 → 加 5 年日 K）', () => {
  assert.ok(rulePlan({ focus: 'industry', question: '现在估值贵不贵' }).steps.some((s) => s.tool === 'valuation'));
  assert.ok(rulePlan({ focus: 'style', question: '现在像历史上哪个阶段' }).steps.some((s) => s.tool === 'index_history_long'));
});

test('规则规划：问题里点名的工具不会被步数上限挤掉（全景 + 历史阶段关键词）', () => {
  const p = rulePlan({ focus: 'overview', question: '现在像历史上哪个阶段' });
  const tools = p.steps.map((s) => s.tool);
  assert.ok(tools.includes('index_history_long'), '关键词命中的 5 年日 K 必须保留');
  assert.ok(p.steps.length <= 14);
  assert.equal(tools[0], 'trading_calendar');
});

test('规则规划：关键词全部命中时，计划覆盖全部 13 个注册工具且不超过上限', () => {
  const p = rulePlan({ focus: 'overview', question: '估值 情绪 连板 行业 题材 成交 消息 历史 宽度' });
  assert.equal(p.steps.length, 13);
  assert.equal(new Set(p.steps.map((s) => s.tool)).size, 13);
});

test('规则规划：历史时点会写明快照类工具将标记为缺失', () => {
  const p = rulePlan({ focus: 'overview', asOf: '2026-06-15' });
  assert.ok(p.notes.some((n) => n.includes('2026-06-15') && n.includes('缺失')));
});

test('模型规划：未注册工具被剔除、漏掉的必需工具由系统补全，且日历排第一', async () => {
  const { llm } = llmWith({ intent: '研究估值', steps: [{ tool: 'valuation', why: '看估值' }, { tool: 'fake_tool', why: '编造的工具' }, { tool: 'valuation', why: '重复' }] });
  const p = await makePlan({ llm, question: '估值如何', focus: 'overview', index: '000001.SH', asOf: null, simulate: new Set() });
  assert.equal(p.planner, 'llm');
  const tools = p.steps.map((s) => s.tool);
  assert.equal(tools[0], 'trading_calendar');
  assert.ok(tools.includes('index_history'));
  assert.ok(!tools.includes('fake_tool'));
  assert.equal(tools.filter((t) => t === 'valuation').length, 1);
  assert.ok(p.notes.some((n) => n.includes('fake_tool')));
  assert.ok(p.notes.some((n) => n.includes('系统补全')));
  assert.ok(p.steps.filter((s) => s.added_by === 'system').length === 2);
});

test('模型规划：发给模型的内容包含工具目录与研判对象，不含任何 Key', async () => {
  const { llm, mock } = llmWith({ intent: 'x', steps: [{ tool: 'index_history', why: 'y' }] });
  await makePlan({ llm, question: '', focus: 'style', index: '000300.SH', asOf: null, simulate: new Set() });
  const u = mock.calls[0].user;
  assert.ok(Array.isArray(u['工具目录']) && u['工具目录'].length === Object.keys(TOOLS).length);
  assert.match(u['研判对象'], /沪深300/);
  assert.ok(!JSON.stringify(u).includes('mock'), '不应把 Key 发给模型');
});

test('模型规划：返回空步骤 / 模型不可用 → 降级为规则规划并写明原因', async () => {
  const { llm } = llmWith({ intent: 'x', steps: [] });
  const p1 = await makePlan({ llm, question: '', focus: 'risk', index: '000001.SH', asOf: null, simulate: new Set() });
  assert.equal(p1.planner, 'rules');
  const p2 = await makePlan({ llm, question: '', focus: 'risk', index: '000001.SH', asOf: null, simulate: new Set(['llm_down']) });
  assert.equal(p2.planner, 'rules');
  assert.ok(p2.notes[0].includes('降级为规则规划'));
  assert.equal(p2.steps[0].tool, 'trading_calendar');
});
