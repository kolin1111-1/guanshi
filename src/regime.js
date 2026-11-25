// 市场状态框架（规则引擎，完全确定、可复现）。
// 产出：各维度评分与标签、综合状态、主要矛盾、置信度（含原因）、状态切换条件。
// 大模型不参与这里的任何数值或标签——它只能解释，不能改判。
import { clamp, fmtNum, fmtPct, fmtYi, round } from './util.js';
import { INDEX_NAMES } from './tools.js';

const ids = (evidence, dim, re) => evidence.filter((e) => e.dim === dim && e.status !== 'missing' && (!re || re.test(e.label))).map((e) => e.id);

export const RULES = {
  trend: '趋势分 = 收盘相对 MA20(±0.5) + 相对 MA60(±0.75) + MA20 相对 MA60(±0.5) + 60 日涨跌/8%(限幅 ±0.75)；≥1 上行趋势，≤−1 下行趋势，其余为震荡',
  breadth: '宽度分 = 0.6×(上涨占比−50%)/15% + 0.4×个股中位数涨跌/1.2%（各自限幅 ±2）；≥0.8 扩散，≤−0.8 收缩，其余为分化',
  liquidity: '流动性分 = (成交额 250 日分位 − 50%)/25%；分位 ≥70% 放量，≤30% 缩量，其余常态',
  sentiment: '情绪分 = (涨停−跌停)/50 + 0.6×(封板率−65%)/15% + 0.4×(涨停/近 10 日均值−1)/0.4（各项限幅）；≥0.7 偏热，≤−0.7 偏冷',
  style: '风格：20 日涨幅差 > 3 个百分点且比值在 60 日均线上方 → 前者占优；反之后者占优；其余为均衡/切换中',
};

const NAME_TABLE = {
  '上行趋势|扩散': '趋势上行 · 普涨扩散',
  '上行趋势|分化': '指数上行 · 个股分化',
  '上行趋势|收缩': '指数上行 · 宽度背离',
  '震荡|扩散': '区间震荡 · 普涨修复',
  '震荡|分化': '区间震荡 · 结构分化',
  '震荡|收缩': '区间震荡 · 普跌偏弱',
  '下行趋势|扩散': '趋势下行 · 普涨反抽',
  '下行趋势|分化': '趋势下行 · 结构分化',
  '下行趋势|收缩': '趋势下行 · 普跌收缩',
};

export function classify({ metrics: M, evidence, gaps, ctx, stale }) {
  const idxName = INDEX_NAMES[ctx.index] || ctx.index;
  const axes = {};

  if (M.close != null) {
    const s = clamp((M.close > M.ma20 ? 0.5 : -0.5) + (M.close > M.ma60 ? 0.75 : -0.75) + (M.ma20 > M.ma60 ? 0.5 : -0.5) + clamp(M.r60 / 8, -0.75, 0.75), -2, 2);
    const label = s >= 1 ? '上行趋势' : s <= -1 ? '下行趋势' : '震荡';
    axes.trend = { name: '趋势', score: round(s, 2), label, critical: Math.abs(s - 1) < 0.3 || Math.abs(s + 1) < 0.3, rule: RULES.trend, evidence: ids(evidence, 'trend') };
  }
  if (M.upRatio != null) {
    const s = clamp(0.6 * clamp((M.upRatio - 50) / 15, -2, 2) + 0.4 * clamp(M.medChg / 1.2, -2, 2), -2, 2);
    const label = s >= 0.8 ? '扩散' : s <= -0.8 ? '收缩' : '分化';
    axes.breadth = { name: '宽度', score: round(s, 2), label, critical: Math.abs(Math.abs(s) - 0.8) < 0.2, rule: RULES.breadth, evidence: ids(evidence, 'breadth') };
  }
  if (M.turnoverPct != null) {
    const s = clamp((M.turnoverPct - 50) / 25, -2, 2);
    const label = M.turnoverPct >= 70 ? '放量' : M.turnoverPct <= 30 ? '缩量' : '常态';
    axes.liquidity = { name: '流动性', score: round(s, 2), label, critical: Math.abs(M.turnoverPct - 70) < 5 || Math.abs(M.turnoverPct - 30) < 5, rule: RULES.liquidity, evidence: ids(evidence, 'liquidity') };
  }
  if (M.limitUp != null) {
    const a = clamp((M.limitUp - (M.limitDown ?? 0)) / 50, -1, 1);
    const b = M.sealRate != null ? 0.6 * clamp((M.sealRate - 65) / 15, -1, 1) : 0;
    const c = M.avgLimitUp10 ? 0.4 * clamp((M.limitUp / M.avgLimitUp10 - 1) / 0.4, -1, 1) : 0;
    const s = clamp(a + b + c, -2, 2);
    const label = s >= 0.7 ? '偏热' : s <= -0.7 ? '偏冷' : '中性';
    axes.sentiment = { name: '情绪', score: round(s, 2), label, critical: Math.abs(Math.abs(s) - 0.7) < 0.15, rule: RULES.sentiment, evidence: ids(evidence, 'sentiment') };
  }
  const styleLabel = (spread, vsMa, a, b) => (spread > 3 && vsMa > 0 ? `${a}占优` : spread < -3 && vsMa < 0 ? `${b}占优` : '均衡/切换中');
  if (M.sizeSpread20 != null) {
    axes.style = {
      name: '风格', score: null,
      label: `${styleLabel(M.sizeSpread20, M.sizeRatioVsMa60, '小盘', '大盘')} · ${M.growthSpread20 != null ? styleLabel(M.growthSpread20, M.growthRatioVsMa60, '成长', '价值') : '成长/价值未知'}`,
      rule: RULES.style, evidence: ids(evidence, 'style'),
    };
  }
  if (M.indDispPct != null) {
    axes.industry = { name: '行业', score: null, label: M.indDispPct >= 70 ? '强弱分化处于高位' : M.indDispPct <= 30 ? '行业走势趋同' : '分化程度常态', rule: '行业 20 日收益横截面标准差的近期分位：≥70% 高分化，≤30% 趋同', evidence: ids(evidence, 'industry') };
  }

  // ---- 综合状态名 ----
  const t = axes.trend?.label, b = axes.breadth?.label;
  const name = t && b ? NAME_TABLE[`${t}|${b}`] : t ? `${t === '震荡' ? '区间震荡' : t}（宽度未知）` : '数据不足，无法判定';

  // ---- 主要矛盾：在候选张力中取最大 ----
  const cands = [];
  const TS = axes.trend?.score, BS = axes.breadth?.score, LS = axes.liquidity?.score, SS = axes.sentiment?.score;
  if (TS != null && BS != null && Math.sign(TS) !== Math.sign(BS) && Math.abs(TS - BS) >= 1) {
    cands.push({ tension: Math.abs(TS - BS), text: TS > BS ? `${idxName}均线结构偏强（趋势分 ${TS}），但多数个股走弱（宽度分 ${BS}）——指数与个股背离` : `个股普遍走强（宽度分 ${BS}），但${idxName}趋势尚未确认（趋势分 ${TS}）`, evidence: [...axes.trend.evidence.slice(0, 2), ...axes.breadth.evidence.slice(0, 2)] });
  }
  if (M.breadthDiv != null && Math.abs(M.breadthDiv) >= 0.8) {
    cands.push({ tension: 0.8 + Math.abs(M.breadthDiv) / 2, text: M.breadthDiv > 0 ? `权重股明显强于典型个股：沪深300 跑赢个股涨跌幅中位数 ${fmtNum(M.breadthDiv)} 个百分点` : `典型个股强于权重股：个股涨跌幅中位数跑赢沪深300 ${fmtNum(-M.breadthDiv)} 个百分点`, evidence: ids(evidence, 'breadth', /中位数/) });
  }
  if (TS != null && LS != null && ((TS >= 0.5 && LS <= -0.6) || (TS <= -0.5 && LS >= 0.6))) {
    cands.push({ tension: Math.abs(TS) + Math.abs(LS), text: TS > 0 ? `价格结构偏强但量能不足：成交额仅处 250 日 ${fmtNum(M.turnoverPct, 0)}% 分位` : `下跌伴随放量：成交额处 250 日 ${fmtNum(M.turnoverPct, 0)}% 分位`, evidence: [...axes.trend.evidence.slice(0, 1), ...axes.liquidity.evidence] });
  }
  if (TS != null && SS != null && ((TS <= -1 && SS >= 0.7) || (TS >= 1 && SS <= -0.7))) {
    cands.push({ tension: Math.abs(TS - SS) * 0.8, text: SS > TS ? `指数趋势偏弱，但短线情绪偏活跃（涨停 ${M.limitUp} 家、最高 ${M.maxBoard ?? '—'} 板）——题材与指数脱节` : `指数结构尚可，但短线情绪降温（封板率 ${fmtNum(M.sealRate, 1)}%）`, evidence: [...axes.trend.evidence.slice(0, 1), ...axes.sentiment.evidence.slice(0, 2)] });
  }
  if (M.sizeSpread20 != null && Math.abs(M.sizeSpread20) >= 5) {
    cands.push({ tension: Math.abs(M.sizeSpread20) / 4, text: `大小盘分化显著：近 20 日${M.sizeSpread20 < 0 ? '沪深300 跑赢中证1000' : '中证1000 跑赢沪深300'} ${fmtNum(Math.abs(M.sizeSpread20))} 个百分点`, evidence: ids(evidence, 'style', /小盘/) });
  }
  if (M.growthSpread20 != null && Math.abs(M.growthSpread20) >= 5) {
    cands.push({ tension: Math.abs(M.growthSpread20) / 4, text: `成长与价值分化显著：近 20 日${M.growthSpread20 < 0 ? '国证价值跑赢国证成长' : '国证成长跑赢国证价值'} ${fmtNum(Math.abs(M.growthSpread20))} 个百分点`, evidence: ids(evidence, 'style', /成长/) });
  }
  if (M.indDispPct != null && M.indDispPct >= 80) {
    cands.push({ tension: 1 + (M.indDispPct - 80) / 20, text: `行业强弱分化处于近期高位（离散度分位 ${fmtNum(M.indDispPct, 0)}%），行情集中于少数方向`, evidence: ids(evidence, 'industry', /离散度|领涨/) });
  }
  cands.sort((x, y) => y.tension - x.tension);
  const main = cands[0] && cands[0].tension >= 1
    ? { ...cands[0], tension: round(cands[0].tension, 2) }
    : { tension: 0, text: Object.keys(axes).length >= 2 ? '各维度信号方向大体一致，暂无突出矛盾；关注切换条件是否被触发' : '可用维度不足，无法识别主要矛盾', evidence: [] };

  // ---- 置信度 ----
  const W = { trend: 0.3, breadth: 0.25, liquidity: 0.2, sentiment: 0.15, style: 0.05, industry: 0.05 };
  const gapDims = gaps.reduce((m, g) => ({ ...m, [g.dim]: (m[g.dim] || 0) + 1 }), {});
  const completeness = Object.entries(W).reduce((s, [k, w]) => s + (axes[k] ? w * Math.max(0.5, 1 - 0.25 * (gapDims[k] || 0)) : 0), 0);
  const dirs = ['trend', 'breadth', 'liquidity', 'sentiment'].map((k) => axes[k]?.score).filter((s) => s != null && Math.abs(s) >= 0.3);
  const pos = dirs.filter((s) => s > 0).length, neg = dirs.filter((s) => s < 0).length;
  const agreement = dirs.length ? Math.max(pos, neg) / dirs.length : 0;
  const conflicts = evidence.filter((e) => e.status === 'conflict');
  const criticals = Object.values(axes).filter((a) => a.critical);
  const tensionPenalty = main.tension >= 1.5 ? 0.05 : 0;
  let value = 0.5 * completeness + 0.35 * agreement + 0.15 * (stale ? 0.3 : 1) - 0.1 * conflicts.length - 0.06 * criticals.length - tensionPenalty;
  value = clamp(value, 0.1, 0.95);
  const reasons = [];
  reasons.push({ sign: completeness >= 0.95 ? '+' : '−', text: `数据完整度 ${fmtNum(completeness * 100, 0)}%${gaps.length ? `（缺口：${[...new Set(gaps.map((g) => g.title))].slice(0, 4).join('、')}）` : ''}` });
  reasons.push({ sign: agreement >= 0.6 ? '+' : '−', text: `方向一致性 ${fmtNum(agreement * 100, 0)}%（趋势/宽度/流动性/情绪中 ${pos} 个偏正、${neg} 个偏负，|评分|<0.3 视为中性不计）` });
  if (stale) reasons.push({ sign: '−', text: `数据时点过期：${stale}` });
  for (const c of conflicts) reasons.push({ sign: '−', text: `数据冲突：${c.label}`, evidence: [c.id] });
  for (const a of criticals) reasons.push({ sign: '−', text: `${a.name}评分 ${a.score} 接近阈值，标签容易翻转` });
  if (tensionPenalty) reasons.push({ sign: '−', text: `存在较强的主要矛盾（张力 ${round(main.tension, 2)}），各维度并非同向`, evidence: main.evidence });
  // 数据完整度不足 80% 时，置信度最高只能是「中」
  const level = value >= 0.8 && completeness >= 0.8 ? '高' : value >= 0.55 ? '中' : '低';
  if (value >= 0.8 && completeness < 0.8) reasons.push({ sign: '−', text: '数据完整度低于 80%，置信度上限为「中」' });

  // ---- 状态切换条件（可观测、带当前值与阈值；是条件，不是预测）----
  const switches = [];
  if (axes.trend) {
    const up = Math.max(M.ma20, M.ma60), dn = Math.min(M.ma20, M.ma60);
    if (axes.trend.label !== '上行趋势') switches.push({ axis: '趋势', from: axes.trend.label, to: '上行趋势', condition: `${idxName} 收盘站上 ${fmtNum(up)} 点（MA20/MA60 较高者）并且 MA20 位于 MA60 之上`, current: `${fmtNum(M.close)} 点`, distance: fmtPct((up / M.close - 1) * 100), evidence: axes.trend.evidence.slice(0, 2) });
    if (axes.trend.label !== '下行趋势') switches.push({ axis: '趋势', from: axes.trend.label, to: axes.trend.label === '上行趋势' ? '震荡' : '下行趋势', condition: axes.trend.label === '上行趋势' ? `${idxName} 收盘跌破 MA60（${fmtNum(M.ma60)} 点）` : `${idxName} 收盘跌破 ${fmtNum(dn)} 点（MA20/MA60 较低者），且近 60 日涨跌幅低于 −5%`, current: `${fmtNum(M.close)} 点，60 日 ${fmtPct(M.r60)}`, distance: fmtPct(((axes.trend.label === '上行趋势' ? M.ma60 : dn) / M.close - 1) * 100), evidence: axes.trend.evidence.slice(0, 3) });
    if (axes.trend.label === '下行趋势') switches.push({ axis: '趋势', from: '下行趋势', to: '震荡', condition: `${idxName} 收盘重新站上 MA20（${fmtNum(M.ma20)} 点）`, current: `${fmtNum(M.close)} 点`, distance: fmtPct((M.ma20 / M.close - 1) * 100), evidence: axes.trend.evidence.slice(0, 2) });
  }
  if (axes.breadth) {
    if (axes.breadth.label !== '扩散') switches.push({ axis: '宽度', from: axes.breadth.label, to: '扩散', condition: '上涨家数占比连续 3 个交易日 > 65%，且个股涨跌幅中位数 > +0.5%', current: `上涨占比 ${fmtNum(M.upRatio, 1)}%，中位数 ${fmtPct(M.medChg)}`, distance: '—', evidence: axes.breadth.evidence.slice(0, 3) });
    if (axes.breadth.label !== '收缩') switches.push({ axis: '宽度', from: axes.breadth.label, to: '收缩', condition: '上涨家数占比连续 3 个交易日 < 35%，且个股涨跌幅中位数 < −0.5%', current: `上涨占比 ${fmtNum(M.upRatio, 1)}%，中位数 ${fmtPct(M.medChg)}`, distance: '—', evidence: axes.breadth.evidence.slice(0, 3) });
  }
  if (axes.liquidity) {
    if (axes.liquidity.label !== '放量') switches.push({ axis: '流动性', from: axes.liquidity.label, to: '放量', condition: `两市成交额回到 250 日 70% 分位以上（≈ ${fmtYi(M.turnoverQ70)}）`, current: fmtYi(M.turnover), distance: fmtPct((M.turnoverQ70 / M.turnover - 1) * 100, 1), evidence: axes.liquidity.evidence });
    if (axes.liquidity.label !== '缩量') switches.push({ axis: '流动性', from: axes.liquidity.label, to: '缩量', condition: `两市成交额跌破 250 日 30% 分位（≈ ${fmtYi(M.turnoverQ30)}）`, current: fmtYi(M.turnover), distance: fmtPct((M.turnoverQ30 / M.turnover - 1) * 100, 1), evidence: axes.liquidity.evidence });
  }
  if (axes.sentiment) {
    if (axes.sentiment.label !== '偏冷') switches.push({ axis: '情绪', from: axes.sentiment.label, to: '偏冷', condition: '封板率跌破 55% 且跌停家数超过涨停家数', current: `封板率 ${fmtNum(M.sealRate, 1)}%，涨停 ${M.limitUp} / 跌停 ${M.limitDown ?? '—'}`, distance: '—', evidence: axes.sentiment.evidence.slice(0, 2) });
    if (axes.sentiment.label !== '偏热') switches.push({ axis: '情绪', from: axes.sentiment.label, to: '偏热', condition: `涨停家数超过近 10 日均值的 1.4 倍（≈ ${fmtNum((M.avgLimitUp10 || 0) * 1.4, 0)} 家）且封板率 > 75%`, current: `涨停 ${M.limitUp} 家，封板率 ${fmtNum(M.sealRate, 1)}%`, distance: '—', evidence: axes.sentiment.evidence.slice(0, 2) });
  }
  if (axes.style && M.sizeRatioMa60) {
    switches.push({ axis: '风格', from: axes.style.label.split(' · ')[0], to: M.sizeRatioVsMa60 > 0 ? '大盘相对占优' : '小盘相对占优', condition: `中证1000/沪深300 比值${M.sizeRatioVsMa60 > 0 ? '跌破' : '站上'}其 60 日均线（${fmtNum(M.sizeRatioMa60, 4)}）`, current: `比值 ${fmtNum(M.sizeRatio, 4)}`, distance: fmtPct((M.sizeRatioMa60 / M.sizeRatio - 1) * 100), evidence: axes.style.evidence.slice(0, 2) });
  }

  return {
    name,
    axes,
    main_contradiction: main,
    other_tensions: cands.slice(1, 3).map((c) => ({ ...c, tension: round(c.tension, 2) })),
    confidence: { level, value: round(value, 2), reasons, formula: '0.5×数据完整度 + 0.35×方向一致性 + 0.15×时效 − 0.1×冲突数 − 0.06×临界维度数 − 0.05×(主要矛盾张力≥1.5)；≥0.8 高，≥0.55 中，其余低' },
    switches,
  };
}
