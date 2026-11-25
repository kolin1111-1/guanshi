// 合规边界：输入侧识别并改写，输出侧拦截；同时检查不误伤正常的事实与条件句
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuestion, sanitize, DISCLAIMER } from '../src/compliance.js';

const flagged = [
  ['明天会涨吗？', '涨跌预测'],
  ['大盘下周还会跌吗', '涨跌预测'],
  ['上证年底能到 4000 点吗', '涨跌预测'],
  ['现在该不该加仓？', '投资建议'],
  ['推荐一只股票', '投资建议'],
  ['仓位应该放几成', '投资建议'],
  ['现在适合抄底吗', '投资建议'],
  ['买这个稳赚吗', '收益承诺'],
];
for (const [q, cat] of flagged) {
  test(`输入侧：「${q}」被识别为${cat}并改写`, () => {
    const r = checkQuestion(q);
    assert.equal(r.flagged, true);
    assert.ok(r.categories.includes(cat), `实际类别：${r.categories}`);
    assert.ok(r.reframed && r.reframed.includes('状态'), '改写为状态研判问题');
    assert.ok(r.notice.includes('不预测涨跌'));
  });
}

const normal = [
  '现在市场是什么状态？',
  '最近是大盘股行情还是小盘股行情？',
  '成交额缩量了吗？情绪是在升温还是降温？',
  '指数在涨但我的股票都在跌，为什么？',
  '',
];
for (const q of normal) {
  test(`输入侧：「${q || '（空问题）'}」不被误标`, () => {
    const r = checkQuestion(q);
    assert.equal(r.flagged, false, `误标类别：${r.categories}`);
    assert.equal(r.reframed, null);
  });
}

const blocked = [
  '综合来看，预计将上涨。',
  '指数有望反弹。',
  '建议逢低买入银行股。',
  '可以适当加仓。',
  '当前仓位不宜过重。',
  '目标点位看到 4000 点。',
  '这是稳赚的机会。',
  '现在是抄底良机。',
];
for (const s of blocked) {
  test(`输出侧：「${s}」被拦截`, () => {
    const r = sanitize(s);
    assert.ok(r.text.includes('〔已拦截'), r.text);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].sentence, s);
  });
}

const allowed = [
  '上涨家数 1952 家，下跌家数 3498 家。',
  '若上证指数收盘站上 MA60，则趋势判断需要改变。',
  '指数当日下跌 0.5%，个股涨跌幅中位数 -0.67%。',
  '趋势判定为「下行趋势」（评分 -2）。',
  '成交额处于近 250 个交易日 12% 分位。',
  '近期事件对市场状态的影响尚无数据验证。',
];
for (const s of allowed) {
  test(`输出侧：「${s}」不被误拦`, () => {
    const r = sanitize(s);
    assert.equal(r.violations.length, 0, `误拦：${JSON.stringify(r.violations)}`);
    assert.equal(r.text, s);
  });
}

test('输出侧：多句文本只替换违规的那一句，其余保留', () => {
  const r = sanitize('上涨家数 1952 家。预计将继续下跌；若站上 MA60 则判断需要改变。');
  assert.ok(r.text.startsWith('上涨家数 1952 家。'));
  assert.ok(r.text.includes('〔已拦截'));
  assert.ok(r.text.endsWith('若站上 MA60 则判断需要改变。'));
  assert.equal(r.violations.length, 1);
});

test('免责声明明确不预测、不给建议', () => {
  assert.ok(DISCLAIMER.includes('不预测涨跌'));
  assert.ok(DISCLAIMER.includes('不构成任何投资建议'));
});
