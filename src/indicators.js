// 指标与证据：把原始字段确定性地加工成「证据」。
// 每条证据都带：来源工具/端点/request_id、原始字段、时点、单位、统计口径、状态（ok / missing / stale / conflict / partial）。
// 这里只做计算，不做判断——判断在 regime.js。
import { INDEX_NAMES } from './tools.js';
import { mean, median, std, pctRank, quantile, smaLast, ret, round, fmtNum, fmtPct, fmtYi, bjDateTime } from './util.js';

const DIM_NAMES = {
  trend: '行情结构', breadth: '市场宽度', style: '风格轮动', industry: '行业结构',
  valuation: '估值', liquidity: '流动性', sentiment: '情绪', events: '重要事件', quality: '数据质量',
};
export { DIM_NAMES };

class EvidenceStore {
  constructor() { this.list = []; this.seq = {}; }
  add(prefix, e) {
    this.seq[prefix] = (this.seq[prefix] || 0) + 1;
    const item = { id: `${prefix}${this.seq[prefix]}`, status: 'ok', kind: 'fact', ...e };
    this.list.push(item);
    return item;
  }
}

function srcOf(result, fields) {
  const provs = result?.provs || [];
  const ok = provs.filter((p) => p.status === 'ok' || p.status === 'empty');
  return {
    tool: provs[0]?.tool || null,
    endpoints: [...new Set(provs.map((p) => p.endpoint))],
    request_ids: ok.map((p) => p.request_id).filter(Boolean).slice(0, 6),
    calls: provs.length,
    failed_calls: provs.filter((p) => p.status === 'error').length,
    fields,
  };
}

/** 日收益序列 */
function dailyReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}
const retN = (closes, n) => (closes.length > n ? ret(closes.at(-1), closes.at(-1 - n)) : null);

/**
 * 计算全部证据与指标
 * @param {object} R 工具结果字典 { toolName: {ok,data,provs,unavailable,reason} }
 * @param {object} ctx { index, tradeDate, asOf, simulate:Set }
 */
export function buildEvidence(R, ctx) {
  const E = new EvidenceStore();
  const M = {}; // 供状态框架使用的数值
  const charts = {};
  const gaps = [];
  const idxName = INDEX_NAMES[ctx.index] || ctx.index;
  const gap = (dim, title, reason, tool) => {
    gaps.push({ dim, title, reason, tool });
    return E.add('G', { dim, kind: 'gap', status: 'missing', label: `${DIM_NAMES[dim]}：${title}`, display: `缺失：${reason}`, value: null, unit: null, as_of: null, source: { tool, endpoints: [], request_ids: [], fields: [] }, method: '数据缺失时不生成结论，只降低该维度权重与整体置信度' });
  };
  const failReason = (r) => {
    if (!r) return '未纳入本次取数计划';
    if (r.unavailable) return r.reason;
    const err = (r.provs || []).find((p) => p.status === 'error');
    return err ? `${err.message}（code=${err.code}）` : '返回为空';
  };

  // ---------------- 行情结构 ----------------
  const H = R.index_history;
  const snapMap = R.index_snapshot?.ok ? R.index_snapshot.data.map : null;
  let bars = H?.ok ? [...(H.data.series[ctx.index] || [])] : [];
  if (ctx.simulate?.has('conflict') && snapMap?.[ctx.index]) snapMap[ctx.index] = { ...snapMap[ctx.index], last_price: snapMap[ctx.index].last_price * 1.02 };
  if (bars.length >= 130) {
    const last = bars.at(-1);
    const snap = snapMap?.[ctx.index];
    // 快照 vs 日 K 冲突检查
    if (snap && last.d === ctx.tradeDate) {
      const diff = Math.abs(snap.last_price / last.c - 1) * 100;
      M.priceConflict = diff;
      if (diff > 0.3) {
        E.add('Q', { dim: 'quality', kind: 'fact', status: 'conflict', label: `${idxName} 快照与日 K 收盘不一致`, value: round(diff, 2), unit: '%', display: `快照 ${fmtNum(snap.last_price)} vs 日 K ${fmtNum(last.c)}，相差 ${fmtNum(diff)}%`, as_of: ctx.tradeDate, source: srcOf(R.index_snapshot, ['last_price', 'close_price']), method: '同一交易日两个来源差异 > 0.3% 视为冲突；结论以日 K 收盘为准并下调置信度' });
      }
    } else if (snap && last.d < ctx.tradeDate) {
      bars.push({ d: ctx.tradeDate, c: snap.last_price, o: snap.open_price, h: snap.high_price, l: snap.low_price, v: snap.volume, t: snap.turnover, provisional: true });
    }
    const closes = bars.map((b) => b.c);
    const c = closes.at(-1);
    const prev = closes.at(-2);
    const ma20 = smaLast(closes, 20), ma60 = smaLast(closes, 60), ma120 = smaLast(closes, 120);
    const r20 = retN(closes, 20), r60 = retN(closes, 60);
    const dr = dailyReturns(closes.slice(-21));
    const vol20 = std(dr) * Math.sqrt(252) * 100;
    const w = closes.slice(-250);
    const hi = Math.max(...w), lo = Math.min(...w);
    const dd = (c / hi - 1) * 100;
    const pos = hi > lo ? ((c - lo) / (hi - lo)) * 100 : null;
    const ma20Prev = smaLast(closes.slice(0, -5), 20);
    Object.assign(M, { close: c, ma20, ma60, ma120, r20, r60, vol20, dd, pos, hi250: hi, lo250: lo, ma20Slope: ret(ma20, ma20Prev) });
    const src = srcOf(H, ['close_price', 'date_ms']);
    E.add('T', { dim: 'trend', label: `${idxName} 收盘点位`, value: round(c, 2), unit: '点', display: `${fmtNum(c)} 点，当日 ${fmtPct(ret(c, prev))}`, as_of: bars.at(-1).d, source: bars.at(-1).provisional ? srcOf(R.index_snapshot, ['last_price']) : src, method: bars.at(-1).provisional ? '日 K 尚未包含当日，取快照 last_price（盘中值，收盘后可能变化）' : '日 K close_price' });
    E.add('T', { dim: 'trend', kind: 'derived', label: `${idxName} 相对均线`, value: round(ret(c, ma60), 2), unit: '%', display: `较 MA20 ${fmtPct(ret(c, ma20))}，较 MA60 ${fmtPct(ret(c, ma60))}，较 MA120 ${fmtPct(ret(c, ma120))}（MA60 = ${fmtNum(ma60)} 点）`, as_of: bars.at(-1).d, source: src, method: 'MA = 最近 N 个交易日收盘价算术平均' });
    E.add('T', { dim: 'trend', kind: 'derived', label: `${idxName} 区间涨跌`, value: round(r60, 2), unit: '%', display: `近 20 日 ${fmtPct(r20)}，近 60 日 ${fmtPct(r60)}`, as_of: bars.at(-1).d, source: src, method: '收盘价相对 N 个交易日前收盘价的涨跌幅' });
    E.add('T', { dim: 'trend', kind: 'derived', label: `${idxName} 波动率`, value: round(vol20, 1), unit: '%', display: `近 20 日年化波动率 ${fmtNum(vol20, 1)}%`, as_of: bars.at(-1).d, source: src, method: '20 日对数收益标准差 × √252' });
    E.add('T', { dim: 'trend', kind: 'derived', label: `${idxName} 250 日区间位置`, value: round(pos, 1), unit: '%', display: `距 250 日高点 ${fmtPct(dd)}，处于 250 日高低区间的 ${fmtNum(pos, 0)}% 位置`, as_of: bars.at(-1).d, source: src, method: '(收盘 − 250 日最低) / (250 日最高 − 250 日最低)' });
    charts.trend = { name: idxName, bars: bars.slice(-160).map((b, i, a) => ({ d: b.d, c: b.c })), ma20: rollingMA(closes, 20).slice(-160), ma60: rollingMA(closes, 60).slice(-160) };
  } else {
    gap('trend', `${idxName} 日 K`, H ? (H.ok ? `历史样本不足（${bars.length} 根 K 线，需 ≥130）` : failReason(H)) : '未取数', 'index_history');
  }

  // ---------------- 市场宽度 ----------------
  const B = R.market_breadth;
  const validB = B?.ok ? B.data.items.filter((x) => x.volume > 0 && x.prev_price > 0 && Number.isFinite(x.price_change_ratio_pct)) : [];
  if (B?.ok && !validB.length) {
    gap('breadth', '全市场涨跌家数', '快照返回成功，但没有当日有成交的有效样本', 'market_breadth');
  } else if (B?.ok) {
    const valid = validB;
    const chg = valid.map((x) => x.price_change_ratio_pct);
    const up = chg.filter((x) => x > 0).length, down = chg.filter((x) => x < 0).length, flat = chg.length - up - down;
    const upRatio = up / chg.length * 100;
    const med = median(chg);
    const big = chg.filter((x) => x >= 5).length, bigDown = chg.filter((x) => x <= -5).length;
    const turnoverAll = valid.reduce((s, x) => s + (x.turnover || 0), 0);
    const idx300 = snapMap?.['000300.SH']?.price_change_ratio_pct ?? (H?.ok ? ret(H.data.series['000300.SH']?.at(-1)?.c, H.data.series['000300.SH']?.at(-2)?.c) : null);
    Object.assign(M, { up, down, flat, upRatio, medChg: med, bigUp: big, bigDown, breadthDiv: idx300 != null ? idx300 - med : null, stockTurnover: turnoverAll });
    const src = srcOf(B, ['price_change_ratio_pct', 'volume', 'prev_price']);
    const status = B.data.complete ? 'ok' : 'partial';
    const asof = sessionLabel(ctx.tradeDate, B.data.timestamp);
    E.add('B', { dim: 'breadth', status, label: '涨跌家数', value: up, unit: '家', display: `上涨 ${up} 家 / 下跌 ${down} 家 / 平盘 ${flat} 家（有效样本 ${chg.length} 家）`, as_of: asof, source: src, method: `全 A（沪深京）个股快照，剔除当日无成交（停牌）个股；代码表共 ${B.data.total} 只${B.data.complete ? '' : '，部分分页失败，样本不完整'}` });
    E.add('B', { dim: 'breadth', status, label: '上涨家数占比', value: round(upRatio, 1), unit: '%', display: `${fmtNum(upRatio, 1)}%`, as_of: asof, source: src, method: '上涨家数 / 有效样本数' });
    E.add('B', { dim: 'breadth', status, label: '个股涨跌幅中位数 vs 沪深300', value: round(med, 2), unit: '%', display: `个股中位数 ${fmtPct(med)}，沪深300 ${fmtPct(idx300)}，差 ${fmtNum(idx300 - med)} 个百分点`, as_of: asof, source: src, method: '中位数反映“典型个股”，与权重指数之差衡量指数与个股是否背离' });
    E.add('B', { dim: 'breadth', status, label: '大幅涨跌家数', value: big, unit: '家', display: `涨幅 ≥5% ${big} 家，跌幅 ≥5% ${bigDown} 家`, as_of: asof, source: src, method: '按 price_change_ratio_pct 计数' });
    // 涨跌幅分布：下跌桶为 (lo, hi]，上涨桶为 [lo, hi)，0 单独成桶
    const buckets = [
      { label: '≤-7', side: 'down', f: (x) => x <= -7 },
      { label: '-7~-5', side: 'down', f: (x) => x > -7 && x <= -5 },
      { label: '-5~-3', side: 'down', f: (x) => x > -5 && x <= -3 },
      { label: '-3~-1', side: 'down', f: (x) => x > -3 && x <= -1 },
      { label: '-1~0', side: 'down', f: (x) => x > -1 && x < 0 },
      { label: '0', side: 'flat', f: (x) => x === 0 },
      { label: '0~1', side: 'up', f: (x) => x > 0 && x < 1 },
      { label: '1~3', side: 'up', f: (x) => x >= 1 && x < 3 },
      { label: '3~5', side: 'up', f: (x) => x >= 3 && x < 5 },
      { label: '5~7', side: 'up', f: (x) => x >= 5 && x < 7 },
      { label: '≥7', side: 'up', f: (x) => x >= 7 },
    ];
    charts.breadth = buckets.map((b) => ({ label: b.label, side: b.side, n: chg.filter(b.f).length }));
  } else {
    gap('breadth', '全市场涨跌家数', failReason(B), 'market_breadth');
  }

  // ---------------- 风格 ----------------
  if (H?.ok) {
    const S = H.data.series;
    const r = (code, n) => { const cl = (S[code] || []).map((b) => b.c); return retN(cl, n); };
    const pairs = [
      { key: 'size', a: '000852.SH', b: '000300.SH', label: '小盘（中证1000）vs 大盘（沪深300）' },
      { key: 'growth', a: '399370.SZ', b: '399371.SZ', label: '成长（国证成长）vs 价值（国证价值）' },
    ];
    for (const p of pairs) {
      const a20 = r(p.a, 20), b20 = r(p.b, 20), a60 = r(p.a, 60), b60 = r(p.b, 60);
      if ([a20, b20, a60, b60].some((x) => x == null)) { gap('style', p.label, '指数日 K 样本不足', 'index_history'); continue; }
      // 比值序列与其 MA60
      const A = S[p.a], Bs = S[p.b];
      const bmap = Object.fromEntries(Bs.map((x) => [x.d, x.c]));
      const ratio = A.filter((x) => bmap[x.d]).map((x) => ({ d: x.d, v: x.c / bmap[x.d] }));
      const rv = ratio.map((x) => x.v);
      const rMa60 = smaLast(rv, 60);
      const ratioVsMa = ret(rv.at(-1), rMa60);
      M[`${p.key}Spread20`] = a20 - b20; M[`${p.key}Spread60`] = a60 - b60; M[`${p.key}RatioVsMa60`] = ratioVsMa;
      M[`${p.key}RatioMa60`] = rMa60; M[`${p.key}Ratio`] = rv.at(-1);
      E.add('S', { dim: 'style', kind: 'derived', label: p.label, value: round(a20 - b20, 2), unit: '个百分点', display: `近 20 日 ${INDEX_NAMES[p.a]} ${fmtPct(a20)} vs ${INDEX_NAMES[p.b]} ${fmtPct(b20)}（差 ${fmtNum(a20 - b20)} 个百分点）；近 60 日差 ${fmtNum(a60 - b60)} 个百分点`, as_of: A.at(-1).d, source: srcOf(H, ['close_price']), method: '两指数同期涨跌幅之差，正值 = 前者占优' });
      E.add('S', { dim: 'style', kind: 'derived', label: `${INDEX_NAMES[p.a]}/${INDEX_NAMES[p.b]} 比值趋势`, value: round(ratioVsMa, 2), unit: '%', display: `比值较其 60 日均线 ${fmtPct(ratioVsMa)}`, as_of: A.at(-1).d, source: srcOf(H, ['close_price']), method: '收盘价比值相对其 60 日均线，正值 = 相对强势仍在延续' });
      charts[`style_${p.key}`] = { label: p.label, series: ratio.slice(-160).map((x) => ({ d: x.d, v: round(x.v, 4) })), ma60: rollingMA(rv, 60).slice(-160) };
    }
    // 宽基横向对比表（图表用）
    charts.indexTable = Object.keys(INDEX_NAMES).filter((k) => S[k]?.length).map((k) => ({ code: k, name: INDEX_NAMES[k], close: S[k].at(-1).c, d: S[k].at(-1).d, r1: round(r(k, 1), 2), r20: round(r(k, 20), 2), r60: round(r(k, 60), 2) }));
  } else {
    gap('style', '风格指数日 K', failReason(H), 'index_history');
  }

  // ---------------- 行业 ----------------
  const I = R.industry_board;
  const indCodes = I?.ok ? Object.keys(I.data.series).filter((k) => I.data.series[k].length > 25) : [];
  if (I?.ok && !indCodes.length) {
    gap('industry', '行业指数', '行业日 K 样本不足（每个行业需 ≥26 根）', 'industry_board');
  } else if (I?.ok) {
    const rows = [];
    const dispSeries = [];
    const codes = indCodes;
    for (const k of codes) {
      const cl = I.data.series[k].map((b) => b.c);
      rows.push({ code: k, name: I.data.names[k], r1: ret(cl.at(-1), cl.at(-2)), r5: retN(cl, 5), r20: retN(cl, 20), d: I.data.series[k].at(-1).d });
    }
    // 离散度历史：每个交易日横截面 20 日收益标准差
    const len = Math.min(...codes.map((k) => I.data.series[k].length));
    for (let back = 0; back < len - 21; back++) {
      const xs = codes.map((k) => { const cl = I.data.series[k].map((b) => b.c); const e = cl.length - 1 - back; return ret(cl[e], cl[e - 20]); }).filter(Number.isFinite);
      dispSeries.unshift(std(xs));
    }
    const disp = dispSeries.at(-1);
    const dispPct = pctRank(dispSeries, disp) * 100;
    const upCnt = rows.filter((x) => x.r1 > 0).length;
    const by20 = [...rows].sort((a, b) => b.r20 - a.r20);
    Object.assign(M, { indUpShare: upCnt / rows.length * 100, indDisp: disp, indDispPct: dispPct, indTop: by20.slice(0, 5), indBottom: by20.slice(-5).reverse() });
    const src = srcOf(I, ['close_price']);
    const asof = rows[0]?.d;
    const status = I.data.received < I.data.expected ? 'partial' : 'ok';
    E.add('I', { dim: 'industry', status, label: '二级行业当日涨跌面', value: upCnt, unit: '个', display: `${upCnt} / ${rows.length} 个同花顺二级行业当日上涨`, as_of: asof, source: src, method: `同花顺二级行业指数（881 开头，共 ${I.data.expected} 个，实取 ${I.data.received} 个）当日收盘涨跌` });
    E.add('I', { dim: 'industry', status, label: '近 20 日领涨 / 领跌行业', value: round(by20[0]?.r20, 2), unit: '%', display: `领涨：${by20.slice(0, 3).map((x) => `${x.name} ${fmtPct(x.r20, 1)}`).join('、')}；领跌：${by20.slice(-3).reverse().map((x) => `${x.name} ${fmtPct(x.r20, 1)}`).join('、')}`, as_of: asof, source: src, method: '行业指数近 20 个交易日涨跌幅排序' });
    E.add('I', { dim: 'industry', kind: 'derived', status, label: '行业轮动离散度', value: round(disp, 2), unit: '个百分点', display: `行业 20 日收益横截面标准差 ${fmtNum(disp)} 个百分点，处于近 ${dispSeries.length} 个交易日的 ${fmtNum(dispPct, 0)}% 分位`, as_of: asof, source: src, method: '离散度越高 = 行业间强弱差距越大（结构性行情特征）' });
    charts.industry = { top: by20.slice(0, 8).map((x) => ({ name: x.name, v: round(x.r20, 2) })), bottom: by20.slice(-8).reverse().map((x) => ({ name: x.name, v: round(x.r20, 2) })), all: rows.map((x) => ({ name: x.name, r1: round(x.r1, 2), r5: round(x.r5, 2), r20: round(x.r20, 2) })) };
  } else {
    gap('industry', '行业指数', failReason(I), 'industry_board');
  }

  const HT = R.hot_topics;
  if (HT?.ok && HT.data.limit_up?.length) {
    const freq = {};
    for (const s of HT.data.limit_up) for (const t of String(s.limit_up_reason || '').split('+').map((x) => x.trim()).filter(Boolean)) freq[t] = (freq[t] || 0) + 1;
    const topT = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6);
    M.themeTop = topT;
    M.themeConcentration = topT.length ? topT[0][1] / HT.data.limit_up.length * 100 : null;
    E.add('I', { dim: 'industry', label: '涨停原因高频题材', value: topT[0]?.[1] ?? 0, unit: '次', display: topT.map(([k, v]) => `${k}×${v}`).join('、') + `（涨停池共 ${HT.data.limit_up.length} 只）`, as_of: ctx.tradeDate, source: srcOf(HT, ['limit_up_reason']), method: '涨停原因按“+”拆分后计数（同花顺标注口径，非本产品归因）' });
  }
  if (HT?.ok && HT.data.hot?.length) {
    E.add('M', { dim: 'sentiment', label: '同花顺热股榜前五', value: null, unit: null, display: HT.data.hot.slice(0, 5).map((x) => `${x.rank}.${x.name}`).join(' '), as_of: sessionLabel(ctx.tradeDate, HT.provs.find((p) => p.endpoint.includes('hot-stock'))?.data_timestamp), source: srcOf(HT, ['rank', 'name', 'heat']), method: '同花顺热度排行（关注度，不代表资金方向）' });
  }

  // ---------------- 估值 ----------------
  const V = R.valuation;
  if (V?.ok) {
    M.valuation = {};
    for (const [code, v] of Object.entries(V.data)) {
      const pe = v.items.map((x) => x.pe_ttm).filter((x) => Number.isFinite(x) && x > 0);
      const pb = v.items.map((x) => x.pb_mrq).filter((x) => Number.isFinite(x) && x > 0);
      const loss = v.items.filter((x) => Number.isFinite(x.pe_ttm) && x.pe_ttm < 0).length;
      const withPe = v.items.filter((x) => Number.isFinite(x.pe_ttm)).length;
      const peMed = median(pe), pbMed = median(pb);
      M.valuation[code] = { peMed, pbMed, lossShare: withPe ? loss / withPe * 100 : null };
      E.add('V', { dim: 'valuation', status: v.items.length < v.constituents * 0.9 ? 'partial' : 'ok', label: `${INDEX_NAMES[code]} 成分股估值`, value: round(peMed, 1), unit: '倍', display: `PE(TTM) 中位数 ${fmtNum(peMed, 1)} 倍，PB(MRQ) 中位数 ${fmtNum(pbMed, 2)} 倍，亏损股占比 ${fmtNum(M.valuation[code].lossShare, 1)}%（${v.items.length}/${v.constituents} 只有估值）`, as_of: sessionLabel(ctx.tradeDate, v.timestamp), source: srcOf(V, ['pe_ttm', 'pb_mrq']), method: '成分股估值中位数（剔除 PE≤0 与空值）；非指数官方加权 PE' });
    }
    E.add('V', { dim: 'valuation', kind: 'gap', status: 'missing', label: '估值历史分位', value: null, unit: null, display: '缺失：接口只提供最新截面，无法判断估值处于历史高位还是低位', as_of: null, source: srcOf(V, []), method: '本产品不据单一截面给出“高估/低估”结论' });
  } else {
    gap('valuation', '成分股估值', failReason(V), 'valuation');
  }

  // ---------------- 流动性 ----------------
  if (H?.ok && H.data.series['000001.SH']?.length > 60 && H.data.series['399001.SZ']?.length > 60) {
    const sz = Object.fromEntries(H.data.series['399001.SZ'].map((b) => [b.d, b.t]));
    let tv = H.data.series['000001.SH'].filter((b) => sz[b.d] != null).map((b) => ({ d: b.d, v: b.t + sz[b.d] }));
    const today = tv.at(-1);
    const vals = tv.map((x) => x.v).slice(-250);
    const avg20 = mean(vals.slice(-21, -1));
    const p = pctRank(vals, today.v) * 100;
    const q50 = quantile(vals, 0.5), q30 = quantile(vals, 0.3), q70 = quantile(vals, 0.7);
    Object.assign(M, { turnover: today.v, turnoverVs20: ret(today.v, avg20), turnoverPct: p, turnoverQ50: q50, turnoverQ30: q30, turnoverQ70: q70 });
    const src = srcOf(H, ['turnover']);
    E.add('L', { dim: 'liquidity', label: '沪深两市成交额', value: round(today.v / 1e8, 0), unit: '亿元', display: `${fmtYi(today.v)}，较前 20 日均值 ${fmtPct(ret(today.v, avg20), 1)}`, as_of: today.d, source: src, method: '上证指数 + 深证成指 当日 turnover（经核对深证成指 turnover 等于深市个股成交额之和）；不含北交所' });
    E.add('L', { dim: 'liquidity', kind: 'derived', label: '成交额历史分位', value: round(p, 0), unit: '%', display: `处于近 ${vals.length} 个交易日的 ${fmtNum(p, 0)}% 分位（中位数 ${fmtYi(q50)}）`, as_of: today.d, source: src, method: '当日成交额在近 250 个交易日中的百分位' });
    charts.liquidity = tv.slice(-160).map((x) => ({ d: x.d, v: round(x.v / 1e8, 0) }));
    if (M.stockTurnover && today.d === ctx.tradeDate) {
      const diff = (M.stockTurnover / today.v - 1) * 100;
      M.turnoverCrossDiff = diff;
      E.add('Q', { dim: 'quality', kind: 'derived', status: Math.abs(diff) > 8 ? 'conflict' : 'ok', label: '成交额交叉核对', value: round(diff, 1), unit: '%', display: `个股快照加总（含北交所）${fmtYi(M.stockTurnover)} vs 指数口径 ${fmtYi(today.v)}，差 ${fmtPct(diff, 1)}`, as_of: ctx.tradeDate, source: srcOf(B, ['turnover']), method: '两种口径相差 > 8% 标记为待核实（口径差异：上证指数成交额含非股票品种的可能、北交所）' });
    }
  } else {
    gap('liquidity', '两市成交额序列', failReason(H), 'index_history');
  }
  const CF = R.capital_flows;
  if (CF) {
    if (!CF.data?.turnover_prediction) gap('liquidity', '成交额预测', failReason({ provs: CF.provs.filter((p) => p.endpoint.includes('turnover')) }), 'capital_flows');
    if (!CF.data?.etf_flow) gap('liquidity', '宽基 ETF 净申购', failReason({ provs: CF.provs.filter((p) => p.endpoint.includes('etf')) }), 'capital_flows');
  }

  // ---------------- 情绪 ----------------
  const LS = R.limit_stats;
  if (LS?.ok) {
    const s = LS.data.stats;
    Object.assign(M, { limitUp: s.limit_up_stock_count, sealRate: s.seal_rate != null ? s.seal_rate * 100 : null, opened: s.open_stock_count, limitDown: LS.data.limit_down });
    E.add('M', { dim: 'sentiment', label: '涨跌停与封板率', value: s.limit_up_stock_count, unit: '家', display: `涨停 ${s.limit_up_stock_count} 家，跌停 ${LS.data.limit_down ?? '—'} 家，炸板 ${s.open_stock_count} 家，封板率 ${fmtNum(M.sealRate, 1)}%`, as_of: s.trade_date, source: srcOf(LS, ['limit_up_stock_count', 'seal_rate', 'open_stock_count', 'pagination.total']), method: '封板率 = 收盘封板家数 / 当日触及涨停家数（接口原值）' });
  } else {
    gap('sentiment', '涨跌停统计', failReason(LS), 'limit_stats');
  }
  const LH = R.limit_stats_history;
  if (LH?.ok) {
    const rows = LH.data.rows.filter((r) => r.ok);
    const prior = rows.filter((r) => r.date < ctx.tradeDate);
    const avgUp = mean(prior.map((r) => r.limit_up)), avgSeal = mean(prior.map((r) => r.seal_rate * 100)), avgDown = mean(prior.map((r) => r.limit_down).filter(Number.isFinite));
    Object.assign(M, { avgLimitUp10: avgUp, avgSeal10: avgSeal, avgLimitDown10: avgDown });
    E.add('M', { dim: 'sentiment', kind: 'derived', status: rows.length < LH.data.rows.length ? 'partial' : 'ok', label: '近期情绪基线', value: round(avgUp, 0), unit: '家', display: `此前 ${prior.length} 个交易日：日均涨停 ${fmtNum(avgUp, 0)} 家，平均封板率 ${fmtNum(avgSeal, 1)}%，日均跌停 ${fmtNum(avgDown, 0)} 家`, as_of: rows.at(-1)?.date, source: srcOf(LH, ['limit_up_stock_count', 'seal_rate']), method: '逐日统计后取算术平均，用作当日情绪的参照基线' });
    charts.sentiment = rows.map((r) => ({ d: r.date, up: r.limit_up, down: r.limit_down, seal: round(r.seal_rate * 100, 1) }));
  } else if (LH) {
    gap('sentiment', '近 10 日情绪序列', failReason(LH), 'limit_stats_history');
  }
  const LD = R.limit_ladder;
  if (LD?.ok) {
    const rows = LD.data.rows;
    const t = rows.at(-1);
    const medMax = median(rows.map((r) => r.max_board));
    Object.assign(M, { maxBoard: t.max_board, medMaxBoard30: medMax });
    E.add('M', { dim: 'sentiment', label: '最高连板高度', value: t.max_board, unit: '板', display: `${t.date} 最高 ${t.max_board} 板（${t.top.slice(0, 3).join('、')}），近 ${rows.length} 个交易日最高板中位数 ${fmtNum(medMax, 0)} 板`, as_of: t.date, source: srcOf(LD, ['board_num', 'name']), method: '连板天梯中当日最大 board_num' });
    charts.ladder = rows.map((r) => ({ d: r.date, v: r.max_board }));
  }

  // ---------------- 重要事件 ----------------
  const N = R.news_flash;
  if (N?.ok) {
    const cls = (t) => (/央行|国务院|证监会|发改委|财政部|政策|会议|监管|印发|通知|降准|降息|利率|关税|LPR/.test(t) ? '政策/宏观' : /美联储|美股|海外|欧洲|日本|美元|原油|黄金|A50|期指|纳斯达克|道指|标普|港股|恒生|英伟达|欧盟/.test(t) ? '海外' : /公告|回购|减持|增持|业绩|中标|收购|重组/.test(t) ? '公司' : '行业/其他');
    const items = N.data.items.slice(0, 8);
    M.newsCount = N.data.items.length;
    for (const x of items) {
      E.add('N', { dim: 'events', label: `[${cls(x.title)}] ${x.title}`, value: null, unit: null, display: (x.summary || '').slice(0, 90), as_of: bjDateTime(x.create_time_ms), source: { ...srcOf(N, ['title', 'summary', 'create_time_ms']), url: x.encoded_url }, method: '快讯原文标题与摘要，仅作事件线索，本产品不对其做方向判断', category: cls(x.title) });
    }
  } else if (N) {
    gap('events', '快讯事件流', failReason(N), 'news_flash');
  }

  return { evidence: E.list, metrics: M, charts, gaps };
}

/** 快照时点说明：收盘后取到的是当日收盘值，盘中取到的是盘中值 */
function sessionLabel(tradeDate, ts) {
  const t = bjDateTime(ts);
  if (!t) return tradeDate;
  const [d, hm] = t.split(' ');
  if (d > tradeDate || hm >= '15:00') return `${tradeDate} 收盘（快照取于 ${t}）`;
  return `${tradeDate} 盘中 ${hm}（非收盘值）`;
}

function rollingMA(a, n) {
  const out = [];
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    out.push(i >= n - 1 ? round(s / n, 4) : null);
  }
  return out;
}
