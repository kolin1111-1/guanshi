// 取数计划：由大模型根据「研判对象 + 时点 + 问题 + 追问方向」从工具目录中挑选工具并说明理由；
// 不可用时降级为关键词规则。无论哪种来源，计划都要经过白名单校验与「必需工具」补全。
import { TOOLS, toolCatalog, INDEX_NAMES } from './tools.js';

export const FOCUS = {
  overview: '全景研判',
  style: '继续研究：风格',
  industry: '继续研究：行业与主线',
  risk: '继续研究：风险变量',
  history: '继续研究：历史阶段对比',
};

const MANDATORY = ['trading_calendar', 'index_history'];
const MAX_STEPS = 14;

const FOCUS_TOOLS = {
  overview: ['index_snapshot', 'market_breadth', 'limit_stats', 'limit_stats_history', 'limit_ladder', 'industry_board', 'hot_topics', 'valuation', 'news_flash', 'capital_flows'],
  style: ['index_snapshot', 'market_breadth', 'industry_board', 'valuation'],
  industry: ['index_snapshot', 'industry_board', 'hot_topics', 'limit_stats', 'news_flash'],
  risk: ['index_snapshot', 'market_breadth', 'limit_stats', 'limit_stats_history', 'limit_ladder', 'capital_flows', 'news_flash'],
  history: ['index_snapshot', 'index_history_long', 'market_breadth', 'limit_stats'],
};
const KEYWORDS = [
  [/估值|贵|便宜|PE|PB|市盈|市净/i, 'valuation'],
  [/情绪|涨停|跌停|连板|炸板|题材|热点|短线/, 'limit_stats'],
  [/情绪|连板|高度/, 'limit_ladder'],
  [/行业|板块|主线|赛道|轮动/, 'industry_board'],
  [/题材|热点|主线|涨停原因/, 'hot_topics'],
  [/成交|量能|资金|流动性|放量|缩量/, 'capital_flows'],
  [/消息|政策|事件|新闻|会议|快讯/, 'news_flash'],
  [/历史|类似|相似|阶段|以前|当年/, 'index_history_long'],
  [/宽度|普涨|普跌|个股|赚钱效应/, 'market_breadth'],
];
const WHY = {
  trading_calendar: '确定研判交易日，判断数据是否过期',
  index_history: '均线、区间位置、波动率、风格相对强弱与成交额分位都依赖日 K',
  index_snapshot: '获取最新点位并与日 K 交叉核对',
  index_history_long: '用 5 年日 K 寻找特征相似的历史阶段',
  market_breadth: '统计全 A 涨跌家数与中位数，判断指数与个股是否背离',
  limit_stats: '涨跌停、封板率衡量短线风险偏好',
  limit_stats_history: '用近 10 日作基线，避免把单日噪音当趋势',
  limit_ladder: '连板高度反映投机情绪强弱',
  industry_board: '行业涨跌面、领涨领跌与离散度刻画结构',
  hot_topics: '涨停原因看题材是否集中',
  valuation: '成分股估值截面（仅最新，无历史分位）',
  news_flash: '列出重要事件线索，作为不确定性来源',
  capital_flows: '尝试补充资金面数据（预期受限，用于暴露数据缺口）',
};

export function rulePlan({ question = '', focus = 'overview', asOf = null }) {
  const set = new Set(MANDATORY);
  for (const [re, tool] of KEYWORDS) if (re.test(question)) set.add(tool); // 问题里点名的工具优先
  for (const t of FOCUS_TOOLS[focus] || FOCUS_TOOLS.overview) set.add(t);
  return finalize([...set].map((tool) => ({ tool, why: WHY[tool] })), { asOf, notes: [] });
}

function finalize(steps, { asOf, notes }) {
  const seen = new Set();
  let out = [];
  for (const s of steps) {
    if (!TOOLS[s.tool]) { notes.push(`剔除未注册工具「${s.tool}」`); continue; }
    if (seen.has(s.tool)) continue;
    seen.add(s.tool);
    out.push({ tool: s.tool, title: TOOLS[s.tool].title, dimension: TOOLS[s.tool].dimension, why: String(s.why || WHY[s.tool] || '').slice(0, 80) });
  }
  for (const m of MANDATORY) {
    if (!seen.has(m)) { out.unshift({ tool: m, title: TOOLS[m].title, dimension: TOOLS[m].dimension, why: WHY[m], added_by: 'system' }); notes.push(`系统补全必需工具「${TOOLS[m].title}」`); }
  }
  // 日历必须第一个执行
  out = [out.find((s) => s.tool === 'trading_calendar'), ...out.filter((s) => s.tool !== 'trading_calendar')];
  if (out.length > MAX_STEPS) {
    // 先移除优先级较低的补充性工具，再兜底截断
    for (const t of ['capital_flows', 'news_flash', 'hot_topics', 'limit_ladder']) {
      if (out.length <= MAX_STEPS) break;
      const i = out.findIndex((s) => s.tool === t);
      if (i > 0) { notes.push(`步骤超过上限 ${MAX_STEPS}，移除优先级较低的「${out[i].title}」`); out.splice(i, 1); }
    }
    if (out.length > MAX_STEPS) { notes.push(`步骤超过上限 ${MAX_STEPS}，已截断`); out = out.slice(0, MAX_STEPS); }
  }
  if (asOf) notes.push(`历史时点 ${asOf}：快照类工具（全市场宽度、估值、快讯、热榜）只有最新值，将标记为缺失而非用最新值冒充`);
  return { steps: out, notes };
}

const SYSTEM = `你是 A 股市场大势研判产品中的「取数规划器」。你的任务：根据用户的研判对象、时点和问题，从工具目录里挑选需要调用的工具，并为每个工具写一句中文理由（≤40 字）。
规则：
1. 只能使用目录中的工具名；不要编造工具。
2. trading_calendar 与 index_history 必选。
3. 只选与问题相关的工具，但「全景研判」应覆盖趋势、宽度、风格、行业、估值、流动性、情绪、事件八类证据。
4. 你不负责下结论，也不预测涨跌。
只输出 JSON：{"intent":"一句话复述用户要研究什么","steps":[{"tool":"工具名","why":"理由"}]}`;

export async function makePlan({ llm, question, focus, index, asOf, simulate }) {
  const user = JSON.stringify({
    研判对象: `${INDEX_NAMES[index] || index}（${index}）`,
    时点: asOf || '最新交易日',
    追问方向: FOCUS[focus] || FOCUS.overview,
    用户问题: question || '（未填写，做全景研判）',
    工具目录: toolCatalog(),
  });
  const r = await llm.chatJSON({ system: SYSTEM, user, maxTokens: 900, simulate });
  if (r.ok && Array.isArray(r.json.steps) && r.json.steps.length) {
    const notes = [];
    const fin = finalize(r.json.steps, { asOf, notes });
    return { planner: 'llm', intent: String(r.json.intent || '').slice(0, 120), ...fin, llm: { latency_ms: r.latency_ms, usage: r.usage, model: r.model } };
  }
  const fb = rulePlan({ question, focus, asOf });
  return { planner: 'rules', intent: `${FOCUS[focus] || FOCUS.overview}：${INDEX_NAMES[index] || index}${question ? `，围绕「${question.slice(0, 40)}」` : ''}`, ...fb, llm: { error: r.error, latency_ms: r.latency_ms }, notes: [r.ok ? '大模型返回的计划为空或格式不符，已降级为规则规划' : `大模型规划不可用（${r.error?.message}），已降级为规则规划`, ...fb.notes] };
}
