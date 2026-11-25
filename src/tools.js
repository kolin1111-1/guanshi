// 工具注册表：每个工具 = 一个可被「取数计划」引用的能力。
// 工具只负责取数与轻度整形，不做判断；判断在 indicators / regime 中完成，保证可复现。
import { DAY, bjDate, bjMidnight, pool } from './util.js';

export const INDEX_NAMES = {
  '000001.SH': '上证指数',
  '399001.SZ': '深证成指',
  '399006.SZ': '创业板指',
  '000300.SH': '沪深300',
  '000016.SH': '上证50',
  '000905.SH': '中证500',
  '000852.SH': '中证1000',
  '000688.SH': '科创50',
  '399370.SZ': '国证成长',
  '399371.SZ': '国证价值',
};
/** 用户可选的研判对象 */
export const TARGET_INDEXES = ['000001.SH', '000300.SH', '000852.SH', '399006.SZ', '000688.SH', '000905.SH'];
/** 风格/基准篮子：一次批量历史调用（上限 10 个）即可覆盖 */
export const CORE_BASKET = Object.keys(INDEX_NAMES);

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const endMs = (ctx) => (ctx.asOf ? bjMidnight(ctx.asOf) + DAY - 1 : Date.now());
const isLatest = (ctx) => !ctx.asOf;
const yyyymmdd = (ms) => bjDate(ms).replace(/-/g, '');
const normBar = (b) => ({ d: bjDate(b.date_ms), o: b.open_price, h: b.high_price, l: b.low_price, c: b.close_price, v: b.volume, t: b.turnover });

function unavailable(reason) {
  return { ok: false, unavailable: true, reason, provs: [] };
}

export const TOOLS = {
  trading_calendar: {
    title: '交易日历',
    dimension: '数据时点',
    description: '取最近交易日序列，用于确定研判时点、判断数据是否过期。',
    endpoint: '/api/a-share/calendar/trading-days',
    async run(ctx) {
      const e = endMs(ctx);
      const r = await ctx.client.get('/api/a-share/calendar/trading-days', { start_date: yyyymmdd(e - 60 * DAY), end_date: yyyymmdd(e) }, { ...ctx.callCtx, tool: 'trading_calendar', ttlMs: 3600000 });
      if (!r.ok) return { ok: false, provs: [r.prov] };
      const days = (r.data.item || []).map((x) => `${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`).sort();
      return { ok: days.length > 0, data: { days }, provs: [r.prov] };
    },
  },

  index_snapshot: {
    title: '指数行情快照',
    dimension: '行情结构',
    description: '主要宽基与风格指数的最新点位、涨跌幅、成交额（仅最新时点）。',
    endpoint: '/api/a-share-index/prices/snapshot',
    async run(ctx) {
      if (!isLatest(ctx)) return unavailable('快照接口只提供最新值，历史时点改用日 K 收盘价');
      const r = await ctx.client.get('/api/a-share-index/prices/snapshot', { thscodes: CORE_BASKET.join(',') }, { ...ctx.callCtx, tool: 'index_snapshot', ttlMs: 60000 });
      if (!r.ok) return { ok: false, provs: [r.prov] };
      const map = Object.fromEntries((r.data.item || []).map((x) => [x.thscode, x]));
      return { ok: true, data: { map, timestamp: r.data.timestamp }, provs: [r.prov] };
    },
  },

  index_history: {
    title: '指数日 K（近 420 天）',
    dimension: '行情结构 / 风格 / 流动性',
    description: '10 个宽基与风格指数的日 K，用于均线、区间位置、波动率、风格相对强弱与成交额分位。',
    endpoint: '/api/a-share-index/prices/historical-batch',
    async run(ctx) {
      const e = endMs(ctx);
      const r = await ctx.client.get('/api/a-share-index/prices/historical-batch', { thscodes: CORE_BASKET.join(','), interval: '1d', start: e - 420 * DAY, end: e }, { ...ctx.callCtx, tool: 'index_history', ttlMs: 300000 });
      if (!r.ok) return { ok: false, provs: [r.prov] };
      const series = {};
      for (const g of r.data.item || []) series[g.thscode] = (g.item || []).map(normBar).filter((b) => !ctx.asOf || b.d <= ctx.asOf);
      return { ok: true, data: { series }, provs: [r.prov] };
    },
  },

  index_history_long: {
    title: '目标指数近 5 年日 K',
    dimension: '历史阶段',
    description: '目标指数近 5 年日 K，用于寻找特征相似的历史阶段。',
    endpoint: '/api/a-share-index/prices/historical',
    async run(ctx) {
      const e = endMs(ctx);
      const start = Date.now() - 5 * 365 * DAY + 3 * DAY; // 接口下界：查询日向前滚动 5 年
      const r = await ctx.client.get('/api/a-share-index/prices/historical', { thscode: ctx.index, interval: '1d', start, end: e }, { ...ctx.callCtx, tool: 'index_history_long', ttlMs: 600000 });
      if (!r.ok) return { ok: false, provs: [r.prov] };
      return { ok: true, data: { bars: (r.data.item || []).map(normBar) }, provs: [r.prov] };
    },
  },

  market_breadth: {
    title: '全市场个股快照（宽度）',
    dimension: '市场宽度',
    description: '分页拉取全 A 个股快照，统计上涨/下跌家数、涨跌幅分布与中位数。',
    endpoint: '/api/a-share/prices/snapshot',
    async run(ctx) {
      if (!isLatest(ctx)) return unavailable('全市场快照只提供最新值；历史日宽度需接入全市场日 K 导出（Parquet），本版本未做');
      const page = 3000;
      const first = await ctx.client.get('/api/a-share/prices/snapshot', { limit: page, offset: 0 }, { ...ctx.callCtx, tool: 'market_breadth', simulateTag: 'breadth_missing', ttlMs: 60000 });
      if (!first.ok) return { ok: false, provs: [first.prov] };
      const total = first.data.total || 0;
      const items = [...(first.data.item || [])];
      const provs = [first.prov];
      const offsets = [];
      for (let off = page; off < total; off += page) offsets.push(off);
      const rest = await pool(offsets, 2, (off) => ctx.client.get('/api/a-share/prices/snapshot', { limit: page, offset: off }, { ...ctx.callCtx, tool: 'market_breadth', ttlMs: 60000 }));
      for (const r of rest) { provs.push(r.prov); if (r.ok) items.push(...(r.data.item || [])); }
      const complete = rest.every((r) => r.ok);
      return { ok: true, data: { items, total, complete, timestamp: first.data.timestamp }, provs };
    },
  },

  limit_stats: {
    title: '涨跌停与封板统计',
    dimension: '情绪',
    description: '研判日涨停家数、封板率、炸板家数、跌停家数与连板分布。',
    endpoint: '/api/a-share/special-data/limit-up-statistics 等',
    async run(ctx) {
      const date = ctx.tradeDate;
      const dms = bjMidnight(date);
      const [st, dn, br] = await Promise.all([
        ctx.client.get('/api/a-share/special-data/limit-up-statistics', { date }, { ...ctx.callCtx, tool: 'limit_stats' }),
        ctx.client.get('/api/a-share/special-data/limit-down-pool', { date_ms: dms, size: 1 }, { ...ctx.callCtx, tool: 'limit_stats' }),
        ctx.client.get('/api/a-share/special-data/limit-break-pool', { date_ms: dms, size: 1 }, { ...ctx.callCtx, tool: 'limit_stats' }),
      ]);
      const provs = [st.prov, dn.prov, br.prov];
      if (!st.ok) return { ok: false, provs };
      return {
        ok: true,
        data: {
          stats: st.data,
          limit_down: dn.ok ? dn.data.pagination?.total ?? null : null,
          limit_break: br.ok ? br.data.pagination?.total ?? null : null,
        },
        provs,
      };
    },
  },

  limit_stats_history: {
    title: '近 10 个交易日涨跌停统计',
    dimension: '情绪',
    description: '逐日取涨停/封板率/跌停，观察短线情绪的方向而非单日噪音。',
    endpoint: '/api/a-share/special-data/limit-up-statistics',
    async run(ctx) {
      const days = (ctx.calendar || []).filter((d) => d <= ctx.tradeDate).slice(-10);
      if (!days.length) return unavailable('缺少交易日历，无法确定回看日期');
      const provs = [];
      const rows = await pool(days, 4, async (date) => {
        const [st, dn] = await Promise.all([
          ctx.client.get('/api/a-share/special-data/limit-up-statistics', { date }, { ...ctx.callCtx, tool: 'limit_stats_history', ttlMs: 3600000 }),
          ctx.client.get('/api/a-share/special-data/limit-down-pool', { date_ms: bjMidnight(date), size: 1 }, { ...ctx.callCtx, tool: 'limit_stats_history', ttlMs: 3600000 }),
        ]);
        provs.push(st.prov, dn.prov);
        if (!st.ok) return { date, ok: false };
        return { date, ok: true, limit_up: st.data.limit_up_stock_count, seal_rate: st.data.seal_rate, opened: st.data.open_stock_count, limit_down: dn.ok ? dn.data.pagination?.total ?? null : null };
      });
      return { ok: rows.some((r) => r.ok), data: { rows }, provs };
    },
  },

  limit_ladder: {
    title: '连板天梯（近 30 交易日）',
    dimension: '情绪',
    description: '连板高度与梯队，衡量短线资金的风险偏好。',
    endpoint: '/api/a-share/special-data/limit-up-ladder',
    async run(ctx) {
      const r = await ctx.client.get('/api/a-share/special-data/limit-up-ladder', {}, { ...ctx.callCtx, tool: 'limit_ladder' });
      if (!r.ok) return { ok: false, provs: [r.prov] };
      const rows = (r.data.item || []).filter((d) => d.date <= ctx.tradeDate).map((d) => {
        const all = Object.values(d.boards || {}).flat();
        const max = all.reduce((m, s) => Math.max(m, s.board_num || 0), 0);
        const top = all.filter((s) => s.board_num === max).map((s) => s.name);
        return { date: d.date, max_board: max, top, multi_board_count: all.length };
      }).sort((a, b) => (a.date < b.date ? -1 : 1));
      if (!rows.length) return unavailable('连板天梯只覆盖近 30 个交易日，研判日不在窗口内');
      return { ok: true, data: { rows }, provs: [r.prov] };
    },
  },

  industry_board: {
    title: '同花顺二级行业指数（90 个）',
    dimension: '行业',
    description: '90 个同花顺二级行业近 150 天日 K，计算当日/20 日涨跌、行业离散度与领涨领跌。',
    endpoint: '/api/a-share-index/catalog/ths-index-list + historical-batch',
    async run(ctx) {
      const cat = await ctx.client.get('/api/a-share-index/catalog/ths-index-list', { tag: 'industry' }, { ...ctx.callCtx, tool: 'industry_board', ttlMs: 86400000 });
      if (!cat.ok) return { ok: false, provs: [cat.prov] };
      const inds = (cat.data.item || []).filter((x) => x.thscode.startsWith('881'));
      const e = endMs(ctx);
      const groups = chunk(inds.map((x) => x.thscode), 10);
      const res = await pool(groups, 3, (g) => ctx.client.get('/api/a-share-index/prices/historical-batch', { thscodes: g.join(','), interval: '1d', start: e - 150 * DAY, end: e }, { ...ctx.callCtx, tool: 'industry_board', ttlMs: 300000 }));
      const series = {};
      for (const r of res) if (r.ok) for (const g of r.data.item || []) series[g.thscode] = (g.item || []).map(normBar).filter((b) => !ctx.asOf || b.d <= ctx.asOf);
      const names = Object.fromEntries(inds.map((x) => [x.thscode, x.name]));
      const okCount = Object.keys(series).length;
      return { ok: okCount > 0, data: { names, series, expected: inds.length, received: okCount }, provs: [cat.prov, ...res.map((r) => r.prov)] };
    },
  },

  valuation: {
    title: '成分股估值截面',
    dimension: '估值',
    description: '沪深300 / 中证500 / 创业板指成分股 PE(TTM)、PB(MRQ) 中位数与亏损占比（仅最新截面，无历史分位）。',
    endpoint: '/api/a-share-index/constituents/ths-stock-list + /api/a-share/valuations/snapshot',
    async run(ctx) {
      if (!isLatest(ctx)) return unavailable('估值接口只提供最新截面，无法回看历史时点');
      const targets = ['000300.SH', '000905.SH', '399006.SZ'];
      const provs = [];
      const out = {};
      for (const code of targets) {
        const cons = await ctx.client.get('/api/a-share-index/constituents/ths-stock-list', { thscode: code }, { ...ctx.callCtx, tool: 'valuation', ttlMs: 86400000 });
        provs.push(cons.prov);
        if (!cons.ok) continue;
        const codes = (cons.data.item || []).map((x) => x.thscode);
        const vals = await pool(chunk(codes, 100), 3, (g) => ctx.client.get('/api/a-share/valuations/snapshot', { thscodes: g.join(',') }, { ...ctx.callCtx, tool: 'valuation', ttlMs: 600000 }));
        provs.push(...vals.map((v) => v.prov));
        const items = vals.filter((v) => v.ok).flatMap((v) => v.data.item || []);
        out[code] = { constituents: codes.length, items, timestamp: Math.max(0, ...vals.filter((v) => v.ok).map((v) => v.data.timestamp || 0)) || null };
      }
      return { ok: Object.keys(out).length > 0, data: out, provs };
    },
  },

  hot_topics: {
    title: '涨停原因与热股榜',
    dimension: '行业 / 情绪',
    description: '涨停股票池的涨停原因（题材集中度）与同花顺热股榜。',
    endpoint: '/api/a-share/special-data/limit-up-pool + hot-stock-list',
    async run(ctx) {
      const [lu, hot] = await Promise.all([
        ctx.client.get('/api/a-share/special-data/limit-up-pool', { date_ms: bjMidnight(ctx.tradeDate), size: 200, sort_field: 'continue_day_cnt', sort_dir: 'desc' }, { ...ctx.callCtx, tool: 'hot_topics' }),
        isLatest(ctx) ? ctx.client.get('/api/a-share/special-data/hot-stock-list', {}, { ...ctx.callCtx, tool: 'hot_topics', ttlMs: 120000 }) : Promise.resolve(null),
      ]);
      const provs = [lu.prov, ...(hot ? [hot.prov] : [])];
      if (!lu.ok && !(hot && hot.ok)) return { ok: false, provs };
      return { ok: true, data: { limit_up: lu.ok ? lu.data.item || [] : null, hot: hot && hot.ok ? hot.data.item || [] : null }, provs };
    },
  },

  news_flash: {
    title: 'A 股快讯（重要事件）',
    dimension: '事件',
    description: '同花顺 A 股栏目最新快讯原文标题与时间，作为事件线索（不做情绪打分）。',
    endpoint: '/api/news/flash/list',
    async run(ctx) {
      if (!isLatest(ctx)) return unavailable('快讯接口只提供最新流，无法回放历史时点');
      const r = await ctx.client.get('/api/news/flash/list', { tag_id: 21103, seq: '0' }, { ...ctx.callCtx, tool: 'news_flash', ttlMs: 120000 });
      if (!r.ok) return { ok: false, provs: [r.prov] };
      return { ok: true, data: { items: r.data.items || [] }, provs: [r.prov] };
    },
  },

  capital_flows: {
    title: '资金面补充（成交额预测 / 宽基 ETF 净申购）',
    dimension: '流动性',
    description: '尝试获取成交额预测与宽基 ETF 净申购；文档标注为 AI 客户端专用，预期失败并作为数据缺口展示。',
    endpoint: '/api/a-share/special-data/turnover-prediction-snapshot + /api/fund/etf-flow/net-inflow-historical',
    async run(ctx) {
      const [tp, etf] = await Promise.all([
        ctx.client.get('/api/a-share/special-data/turnover-prediction-snapshot', {}, { ...ctx.callCtx, tool: 'capital_flows' }),
        ctx.client.get('/api/fund/etf-flow/net-inflow-historical', {}, { ...ctx.callCtx, tool: 'capital_flows' }),
      ]);
      return { ok: tp.ok || etf.ok, data: { turnover_prediction: tp.ok ? tp.data : null, etf_flow: etf.ok ? etf.data : null }, provs: [tp.prov, etf.prov] };
    },
  },
};

/** 给规划器看的工具目录（不含实现） */
export function toolCatalog() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, title: t.title, dimension: t.dimension, description: t.description }));
}
