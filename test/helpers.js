// 测试辅助：构造数据与模拟 fetch。
// 全部数据都由确定性公式生成（不是真实行情的拷贝），所有请求都被模拟路由拦截，零外网访问。
import { DAY, bjDate, bjMidnight } from '../src/util.js';
import { buildEvidence } from '../src/indicators.js';
import { classify } from '../src/regime.js';
import { INDEX_NAMES } from '../src/tools.js';

export const FAKE_KEY = 'test-key-not-real';

// 兜底：任何测试文件只要引入了本辅助模块，全局 fetch 就被替换为“禁止外网”，
// 一旦有代码绕过注入的 fetchImpl 去访问真实网络，测试会立即失败。
globalThis.fetch = async (url) => { throw new Error(`测试禁止访问真实网络：${url}`); };

/** 北京时间的星期几（0=周日） */
const bjWeekday = (ms) => new Date(ms + 8 * 3600000).getUTCDay();

/** 以 endStr 结束（含）的 n 个工作日，升序 */
export function weekdaysEnding(endStr, n) {
  const out = [];
  let ms = bjMidnight(endStr);
  while (out.length < n) {
    const w = bjWeekday(ms);
    if (w !== 0 && w !== 6) out.unshift(bjDate(ms));
    ms -= DAY;
  }
  return out;
}

/** 今天（北京时间）之前最近的一个工作日 */
export function lastWeekdayBeforeToday() {
  let ms = bjMidnight(bjDate(Date.now())) - DAY;
  while ([0, 6].includes(bjWeekday(ms))) ms -= DAY;
  return bjDate(ms);
}

/** 生成日 K：closeFn(i, n) 给收盘价，tvFn(i, n) 给成交额（元） */
export function genBars(days, closeFn, tvFn = (i) => 8e11 * (1 + 0.3 * Math.sin(i / 13))) {
  const n = days.length;
  return days.map((d, i) => {
    const c = closeFn(i, n);
    return { d, o: c * 0.998, h: c * 1.006, l: c * 0.994, c, v: 3e10, t: tvFn(i, n) };
  });
}

export const SHAPES = {
  up: (i) => 3000 * Math.exp(0.0012 * i) * (1 + 0.004 * Math.sin(i / 3)),
  down: (i) => 4000 * Math.exp(-0.0012 * i) * (1 + 0.004 * Math.sin(i / 3)),
  // 平台 → 冲高 → 回落 → 末日小幅反弹：收盘 > MA20、< MA60、MA20 < MA60、60 日涨跌≈+0.6% → 趋势分约 −0.68（震荡）
  range: (i, n) => (i < n - 60 ? 3500 : i < n - 20 ? 3600 : i < n - 1 ? 3450 : 3520),
};

/** 构造工具返回里的溯源记录 */
export function prov(tool, endpoint, status = 'ok', extra = {}) {
  return { source: '测试构造', tool, endpoint, params: {}, request_id: `req-${tool}`, http: 200, code: status === 'ok' ? 0 : 5003, message: status === 'ok' ? 'success' : '数据源不可用', data_timestamp: Date.now(), fetched_at: Date.now(), latency_ms: 1, cached: false, status, ...extra };
}

/** 构造全市场快照：upRatio（0~1）比例的股票上涨 upChg%，其余下跌 downChg%，另含平盘与停牌 */
export function genStocks({ n = 1000, upRatio = 0.5, upChg = 1.5, downChg = -1.5, flat = 10, suspended = 5, spread = 0.9 } = {}) {
  const items = [];
  const nUp = Math.round((n - flat) * upRatio);
  for (let i = 0; i < n; i++) {
    const chg = i < flat ? 0 : i < flat + nUp ? upChg + (i % 7) * spread : downChg - (i % 7) * spread;
    items.push({ thscode: `${String(600000 + i).padStart(6, '0')}.SH`, ticker: String(600000 + i), last_price: 10 * (1 + chg / 100), prev_price: 10, price_change_ratio_pct: chg, volume: 1e6, turnover: 1e8 });
  }
  for (let i = 0; i < suspended; i++) items.push({ thscode: `${300000 + i}.SZ`, ticker: String(300000 + i), last_price: 10, prev_price: 10, price_change_ratio_pct: 0, volume: 0, turnover: 0 });
  return items;
}

/**
 * 构造工具结果字典 R（用于 indicators / regime 单元测试，不经过 HTTP）
 * @param {object} o
 */
export function makeR({
  tradeDate = '2026-11-20', shape = 'up', codes = Object.keys(INDEX_NAMES), lastTurnover = null,
  breadth = { upRatio: 0.8 }, limit = { up: 120, down: 5, seal: 0.85, opened: 10 }, snapshot = null, capitalFlows = true,
} = {}) {
  const days = weekdaysEnding(tradeDate, 320);
  const series = {};
  for (const code of codes) {
    const tvFn = (i, n) => (i === n - 1 && lastTurnover != null ? lastTurnover(code) : (code === '399001.SZ' ? 9e11 : 8e11) * (1 + 0.3 * Math.sin(i / 13)));
    series[code] = genBars(days, SHAPES[shape], tvFn);
  }
  const R = { index_history: { ok: true, data: { series }, provs: [prov('index_history', '/api/a-share-index/prices/historical-batch')] } };
  if (snapshot) {
    const map = Object.fromEntries(Object.entries(snapshot).map(([code, s]) => [code, { thscode: code, ...s }]));
    R.index_snapshot = { ok: true, data: { map, timestamp: Date.now() }, provs: [prov('index_snapshot', '/api/a-share-index/prices/snapshot')] };
  }
  if (breadth) {
    const items = genStocks(breadth);
    R.market_breadth = { ok: true, data: { items, total: items.length, complete: true, timestamp: bjMidnight(tradeDate) + 16 * 3600000 }, provs: [prov('market_breadth', '/api/a-share/prices/snapshot')] };
  } else if (breadth === false) {
    R.market_breadth = { ok: false, provs: [prov('market_breadth', '/api/a-share/prices/snapshot', 'error', { code: 5003, message: '数据源不可用' })] };
  }
  if (limit) {
    R.limit_stats = { ok: true, data: { stats: { trade_date: tradeDate, seal_rate: limit.seal, open_stock_count: limit.opened, limit_up_stock_count: limit.up }, limit_down: limit.down, limit_break: limit.opened }, provs: [prov('limit_stats', '/api/a-share/special-data/limit-up-statistics')] };
  }
  if (capitalFlows) {
    R.capital_flows = { ok: false, data: { turnover_prediction: null, etf_flow: null }, provs: [
      prov('capital_flows', '/api/a-share/special-data/turnover-prediction-snapshot', 'error', { code: 2004, message: '该数据为同花顺AI客户端专用，外部不可调用' }),
      prov('capital_flows', '/api/fund/etf-flow/net-inflow-historical', 'error', { code: 2004, message: '该数据为同花顺AI客户端专用，外部不可调用' }),
    ] };
  }
  return { R, ctx: { index: '000001.SH', tradeDate, asOf: null, simulate: new Set() } };
}

/** 复刻 research.js 的报告拼装（只到规则判定这一步） */
export function buildReport(R, ctx, { stale = null, focus = 'overview', question = '' } = {}) {
  const built = buildEvidence(R, ctx);
  const regime = classify({ metrics: built.metrics, evidence: built.evidence, gaps: built.gaps, ctx, stale });
  return {
    input: { question, index: ctx.index, indexName: INDEX_NAMES[ctx.index], focus, asOf: ctx.asOf },
    trade_date: ctx.tradeDate, guard: { flagged: false }, regime,
    evidence: built.evidence, metrics: built.metrics, gaps: built.gaps, charts: built.charts,
  };
}

// ---------------- 模拟 HTTP ----------------
let rid = 0;
export const envelope = (data, code = 0, message = 'success') => ({ code, message, request_id: `mock-${++rid}`, data });
export const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/** 一个会一直挂起、直到被 AbortSignal 取消的 fetch（用于超时测试） */
export function hangingFetch() {
  return (url, opts = {}) => new Promise((_, reject) => {
    const abort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
    if (opts.signal?.aborted) return abort();
    opts.signal?.addEventListener('abort', abort);
  });
}

/**
 * 扶摇模拟路由：按 URL 路径返回构造数据。lastDay 为构造数据的最后一个交易日。
 * 任何非 mock 主机的请求都会抛错，确保测试零外网访问。
 */
export function makeFuyaoMock({ lastDay = lastWeekdayBeforeToday(), shapeOf = () => 'down' } = {}) {
  const calls = [];
  const allDays = weekdaysEnding(lastDay, 1300);
  const barsCache = {};
  const barsOf = (code) => {
    if (!barsCache[code]) {
      const drift = { '000852.SH': -0.0016, '399370.SZ': -0.0013, '399371.SZ': 0.0002, '000300.SH': -0.0005 }[code] ?? -0.0008;
      const base = code.endsWith('.TI') ? 1000 + (parseInt(code.slice(3, 6), 10) % 20) * 50 : 3000;
      const tvBase = code === '399001.SZ' ? 9e11 : 8e11;
      const shape = shapeOf(code);
      barsCache[code] = genBars(allDays, shape === 'up' ? (i) => base * Math.exp(0.0009 * i) : (i) => base * Math.exp(drift * (i - 1000)) * (1 + 0.004 * Math.sin(i / 3 + code.length)), (i) => tvBase * (1 + 0.3 * Math.sin(i / 13)));
    }
    return barsCache[code];
  };
  const toApiBar = (b) => ({ date_ms: bjMidnight(b.d), open_price: b.o, high_price: b.h, low_price: b.l, close_price: b.c, volume: b.v, turnover: b.t });
  const inRange = (b, s, e) => bjMidnight(b.d) >= Number(s) && bjMidnight(b.d) <= Number(e);
  const stocks = genStocks({ n: 4000, upRatio: 0.35 });
  const industries = Array.from({ length: 12 }, (_, i) => ({ thscode: `8811${String(i + 1).padStart(2, '0')}.TI`, name: `构造行业${i + 1}` }));

  const routes = {
    '/api/a-share/calendar/trading-days': (q) => envelope({ timestamp: Date.now(), item: allDays.filter((d) => d.replace(/-/g, '') >= q.get('start_date') && d.replace(/-/g, '') <= q.get('end_date')).map((d) => ({ date_ms: bjMidnight(d), date: d.replace(/-/g, '') })) }),
    '/api/a-share-index/prices/historical-batch': (q) => envelope({ interval: '1d', adjust: null, item: q.get('thscodes').split(',').map((code) => { const it = barsOf(code).filter((b) => inRange(b, q.get('start'), q.get('end'))).map(toApiBar); return { thscode: code, timestamp: it.at(-1)?.date_ms ?? null, item: it }; }) }),
    '/api/a-share-index/prices/historical': (q) => envelope({ timestamp: Date.now(), adjust: null, item: barsOf(q.get('thscode')).filter((b) => inRange(b, q.get('start'), q.get('end'))).map(toApiBar) }),
    '/api/a-share-index/prices/snapshot': (q) => envelope({ timestamp: bjMidnight(lastDay) + 16 * 3600000, total: 0, item: q.get('thscodes').split(',').map((code) => { const b = barsOf(code); const c = b.at(-1).c, p = b.at(-2).c; return { thscode: code, last_price: c, prev_price: p, price_change: c - p, price_change_ratio_pct: (c / p - 1) * 100, open_price: c, high_price: c, low_price: c, volume: 1, turnover: b.at(-1).t }; }) }),
    '/api/a-share/prices/snapshot': (q) => { const off = Number(q.get('offset') || 0), lim = Number(q.get('limit') || 100); return envelope({ timestamp: bjMidnight(lastDay) + 16 * 3600000, total: stocks.length, item: stocks.slice(off, off + lim) }); },
    '/api/a-share/special-data/limit-up-statistics': (q) => envelope({ timestamp: Date.now(), trade_date: q.get('date'), seal_rate: 0.6, open_stock_count: 30, limit_up_stock_count: 45, touched_limit_up_stock_count: 75, page_boards: [], exact_boards: [] }),
    '/api/a-share/special-data/limit-down-pool': () => envelope({ timestamp: Date.now(), pagination: { total: 12, pages: 12, size: 1, page: 1 }, item: [{ thscode: '600001.SH', name: '构造股A' }] }),
    '/api/a-share/special-data/limit-break-pool': () => envelope({ timestamp: Date.now(), pagination: { total: 30, pages: 30, size: 1, page: 1 }, item: [{ thscode: '600002.SH', name: '构造股B' }] }),
    '/api/a-share/special-data/limit-up-ladder': () => envelope({ timestamp: Date.now(), window: { length: 30 }, item: allDays.slice(-30).reverse().map((d, i) => ({ date: d, boards: { two_board: [{ thscode: '600003.SH', name: '构造股C', board_num: 2 + (i % 3) }] } })) }),
    '/api/a-share-index/catalog/ths-index-list': () => envelope({ timestamp: Date.now(), item: [...industries, { thscode: '884001.TI', name: '三级行业不取' }] }),
    '/api/a-share-index/constituents/ths-stock-list': () => envelope({ timestamp: Date.now(), item: stocks.slice(0, 20).map((s) => ({ thscode: s.thscode, ticker: s.ticker, name: `构造${s.ticker}` })) }),
    '/api/a-share/valuations/snapshot': (q) => envelope({ timestamp: Date.now(), total: 0, item: q.get('thscodes').split(',').map((c, i) => ({ thscode: c, ticker: c.slice(0, 6), name: '构造', pe_ttm: i % 5 === 0 ? -8 : 10 + i, pe_mrq: 10, pb_mrq: 1 + i / 10, ps_ttm: 2, pcf_ttm: 5 })) }),
    '/api/a-share/special-data/limit-up-pool': () => envelope({ timestamp: Date.now(), pagination: { total: 3 }, item: [{ name: '甲', limit_up_reason: '机器人+芯片' }, { name: '乙', limit_up_reason: '机器人' }, { name: '丙', limit_up_reason: '算力' }] }),
    '/api/a-share/special-data/hot-stock-list': () => envelope({ timestamp: Date.now(), item: [{ rank: 1, name: '构造热股1' }, { rank: 2, name: '构造热股2' }] }),
    '/api/news/flash/list': () => ({ code: 0, message: 'success', request_id: `mock-${++rid}`, data: { items: [{ id: '1', seq: '1', title: '构造快讯：某部门印发通知', summary: '构造摘要', create_time_ms: Date.now() - 3600000, encoded_url: 'https://example.org/x', tags: [] }] } }),
    '/api/a-share/special-data/turnover-prediction-snapshot': () => envelope(null, 2004, '该数据为同花顺AI客户端专用'),
    '/api/fund/etf-flow/net-inflow-historical': () => envelope(null, 2004, '该数据为同花顺AI客户端专用'),
  };

  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.host !== 'mock.fuyao') throw new Error(`测试中出现非模拟主机请求：${u.host}`);
    if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), key: opts.headers?.['X-api-key'] });
    const h = routes[u.pathname];
    if (!h) return jsonResponse(envelope(null, 3001, `mock 未定义路由 ${u.pathname}`));
    return jsonResponse(h(u.searchParams));
  };
  return { fetch, calls, lastDay, allDays, baseUrl: 'http://mock.fuyao' };
}

/**
 * 模拟大模型：根据 system 提示判断是「取数规划」还是「研判叙述」，返回预设或按证据动态生成的 JSON。
 */
export function makeLLMMock({ plan, narrate, status = 200 } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.host !== 'mock.llm') throw new Error(`测试中出现非模拟主机请求：${u.host}`);
    const body = JSON.parse(opts.body);
    const system = body.messages[0].content;
    const user = JSON.parse(body.messages[1].content);
    const kind = system.includes('取数规划器') ? 'plan' : 'narrate';
    calls.push({ kind, user });
    if (status !== 200) return jsonResponse({ error: { message: 'Insufficient Balance' } }, status);
    const out = kind === 'plan' ? (typeof plan === 'function' ? plan(user) : plan) : (typeof narrate === 'function' ? narrate(user) : narrate);
    if (out == null) return jsonResponse({ choices: [{ message: { content: 'not json' } }] });
    return jsonResponse({ model: 'mock-model', usage: { total_tokens: 10 }, choices: [{ message: { content: JSON.stringify(out) } }] });
  };
  return { fetch, calls, baseUrl: 'http://mock.llm' };
}
