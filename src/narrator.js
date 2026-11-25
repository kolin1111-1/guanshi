// 研判叙述：大模型基于「证据 + 规则判定」写结论；输出必须逐条引用证据，且通过三道校验：
//   ① 引用存在性：每条结论引用的证据 ID 必须真实存在且非缺失；
//   ② 数值一致性：结论中出现的数字必须能在其引用证据里找到（只允许四舍五入）；
//   ③ 合规拦截：涨跌预测、买卖/仓位建议、收益承诺类表述被替换。
// 大模型不可用或校验后无可用内容时，降级为确定性模板叙述（页面明确标注）。
import { sanitize } from './compliance.js';
import { fmtNum, fmtPct, fmtYi } from './util.js';
import { INDEX_NAMES } from './tools.js';
import { FOCUS } from './planner.js';

/** 把规则判定也变成可引用的“证据”（R/C 前缀），这样模型复述它们时也能被核对 */
export function regimeEvidence(regime) {
  const list = [];
  list.push({ id: 'R1', dim: 'regime', kind: 'inference', label: '综合状态', display: `${regime.name}（置信度 ${regime.confidence.level}，${regime.confidence.value}）` });
  Object.values(regime.axes).forEach((a, i) => list.push({ id: `R${i + 2}`, dim: 'regime', kind: 'inference', label: `${a.name}判定`, display: `${a.name}：${a.label}${a.score != null ? `（评分 ${a.score}）` : ''}`, method: `规则：${a.rule}`, refs: a.evidence }));
  list.push({ id: 'R9', dim: 'regime', kind: 'inference', label: '主要矛盾', display: regime.main_contradiction.text, refs: regime.main_contradiction.evidence });
  regime.switches.forEach((s, i) => list.push({ id: `C${i + 1}`, dim: 'switch', kind: 'inference', label: `${s.axis}：${s.from}→${s.to}`, display: `${s.condition}；当前 ${s.current}；距离 ${s.distance}`, refs: s.evidence }));
  return list;
}

const NUM_RE = /[-+−]?\d+(?:,\d{3})*(?:\.\d+)?/g;
const WINDOW_OK = new Set([1, 3, 5, 10, 20, 30, 50, 60, 90, 100, 120, 250, 300, 500, 1000]);
const toNum = (s) => Number(String(s).replace(/,/g, '').replace('−', '-'));

/**
 * 结论里的每个数字都要在引用证据中出现。
 * 容差只允许「按结论写出的小数位四舍五入」：证据 3548.37 → 结论可写 3548.4 / 3548，不能写 3550 / 3580。
 * 符号可以不同（“跑赢 7.66 个百分点” 对应证据中的 −7.66）。
 * 候选数字只取证据的标签、内容和数值，不含规则说明，避免规则里的阈值（如 65%）被当作事实放行。
 */
export function verifyNumbers(text, cited) {
  const pool = [];
  for (const e of cited) {
    const s = `${e.label} ${e.display} ${e.value ?? ''}`;
    for (const m of s.match(NUM_RE) || []) pool.push(toNum(m));
  }
  const bad = [];
  const src = String(text);
  for (const mm of src.matchAll(NUM_RE)) {
    const m = mm[0];
    const n = toNum(m);
    if (!Number.isFinite(n)) continue;
    if (WINDOW_OK.has(Math.abs(n)) && !m.includes('.')) continue; // 窗口长度等口径整数（20 日、60 日…）
    const after = src.slice(mm.index + m.length, mm.index + m.length + 3);
    if (/^\d{6}$/.test(m.replace(/^[-+−]/, '')) && /^\.(SH|SZ|BJ)/i.test(after)) continue; // 带交易所后缀的证券代码
    const dec = (m.split('.')[1] || '').length;
    const tol = 0.5 * 10 ** -dec + 1e-9;
    const ok = pool.some((p) => Math.abs(p - n) <= tol || Math.abs(Math.abs(p) - Math.abs(n)) <= tol);
    if (!ok) bad.push(m);
  }
  return bad;
}

const SYSTEM = `你是 A 股市场大势研判产品的「研判叙述员」。你会收到：用户问题、规则引擎给出的状态判定（不可修改）、以及带 ID 的证据列表。
写作要求：
1. 只根据给定证据写作，不得引入证据之外的数据、新闻或常识性数字；每条结论必须在 evidence 字段列出所依据的证据 ID（1~4 个）。
2. 结论分三类：fact（事实：直接复述证据数值）、inference（归纳：多条证据共同支持的判断，须与规则判定一致）、uncertain（不确定：信号冲突、数据缺口、事件影响未知等）。三类都要有。
3. 严禁：预测涨跌或点位（如“将上涨”“有望反弹”“大概率回调”）、买卖/仓位/配置建议、收益承诺。可以写“若……则判断需要改变”这类条件句。
4. 引用数字时保持与证据完全一致（含单位），不要自行计算新数字。
5. 中文，简洁专业；headline ≤ 30 字，summary ≤ 120 字，每条 finding ≤ 70 字，answer ≤ 160 字。
只输出 JSON：{"headline":"","summary":"","findings":[{"type":"fact|inference|uncertain","text":"","evidence":["ID"]}],"answer":"直接回应用户问题（若问题被改写，回应改写后的问题）","watch":[{"text":"需要跟踪的条件","evidence":["C1"]}]}`;

function compactEvidence(list) {
  return list.map((e) => ({ id: e.id, 维度: e.dim, 类型: e.kind, 标签: e.label, 内容: e.display, 时点: e.as_of || undefined, 状态: e.status && e.status !== 'ok' ? e.status : undefined }));
}

/**
 * @returns {Promise<object>} narrative
 */
export async function narrate({ llm, report, simulate }) {
  const all = [...report.evidence, ...regimeEvidence(report.regime)];
  const byId = Object.fromEntries(all.map((e) => [e.id, e]));
  const user = JSON.stringify({
    研判对象: report.input.indexName,
    研判交易日: report.trade_date,
    追问方向: FOCUS[report.input.focus],
    用户问题: report.guard?.flagged ? report.guard.reframed : report.input.question || '做一次全景研判',
    规则判定: { 状态: report.regime.name, 置信度: report.regime.confidence, 主要矛盾: report.regime.main_contradiction.text },
    证据: compactEvidence(all.filter((e) => e.dim !== 'events' || report.input.focus !== 'history').slice(0, 70)),
    历史相似阶段: report.analogs ? report.analogs.items.map((a) => ({ 日期: a.date, 特征: a.features_text, 之后20日: a.after_text })) : undefined,
  });
  const r = await llm.chatJSON({ system: SYSTEM, user, maxTokens: 1800, simulate });
  if (!r.ok) return { ...templateNarrative(report), source: 'template', fallback_reason: r.error?.message };

  const validation = { checked: 0, passed: 0, dropped: [], violations: [] };
  const clean = (s) => {
    const z = sanitize(String(s || ''));
    validation.violations.push(...z.violations);
    return z.text;
  };
  const findings = [];
  for (const f of Array.isArray(r.json.findings) ? r.json.findings : []) {
    validation.checked++;
    const evIds = (Array.isArray(f.evidence) ? f.evidence : []).map(String).filter((id) => byId[id]);
    const type = ['fact', 'inference', 'uncertain'].includes(f.type) ? f.type : 'uncertain';
    if (!evIds.length) { validation.dropped.push({ text: f.text, reason: '未引用任何有效证据 ID' }); continue; }
    const usable = evIds.filter((id) => byId[id].status !== 'missing' || type === 'uncertain');
    if (!usable.length) { validation.dropped.push({ text: f.text, reason: '引用的证据为缺失状态，却被写成确定结论' }); continue; }
    const cited = usable.flatMap((id) => [byId[id], ...(byId[id].refs || []).map((x) => byId[x]).filter(Boolean)]);
    const bad = verifyNumbers(f.text, cited);
    if (bad.length) { validation.dropped.push({ text: f.text, reason: `数字 ${bad.join('、')} 在引用证据中找不到` }); continue; }
    const text = clean(f.text);
    findings.push({ type, text, evidence: usable });
    validation.passed++;
  }
  const allNums = (s) => verifyNumbers(s, all);
  let summary = clean(r.json.summary);
  if (allNums(summary).length) { validation.dropped.push({ text: summary, reason: `摘要中的数字 ${allNums(summary).join('、')} 无法核对，已改用模板摘要` }); summary = templateNarrative(report).summary; }
  let answer = clean(r.json.answer);
  if (allNums(answer).length) { validation.dropped.push({ text: answer, reason: `回答中的数字 ${allNums(answer).join('、')} 无法核对，已改用模板回答` }); answer = templateNarrative(report).answer; }
  const watch = (Array.isArray(r.json.watch) ? r.json.watch : []).map((w) => ({ text: clean(w.text), evidence: (w.evidence || []).filter((id) => byId[id]) })).filter((w) => w.evidence.length).slice(0, 5);

  if (findings.length < 3) {
    return { ...templateNarrative(report), source: 'template', fallback_reason: `模型输出通过校验的结论不足 3 条（${findings.length}/${validation.checked}）`, validation };
  }
  return {
    source: 'llm',
    model: r.model,
    latency_ms: r.latency_ms,
    usage: r.usage,
    headline: clean(r.json.headline).slice(0, 40) || report.regime.name,
    summary,
    findings,
    answer,
    watch: watch.length ? watch : templateNarrative(report).watch,
    validation,
  };
}

/** 确定性模板叙述（大模型不可用时的降级方案，也是测试基线） */
export function templateNarrative(report) {
  const { regime, metrics: M } = report;
  const ev = report.evidence;
  const first = (dim, re) => ev.find((e) => e.dim === dim && e.status !== 'missing' && (!re || re.test(e.label)))?.id;
  const A = regime.axes;
  const idx = report.input.indexName;
  const parts = [];
  if (A.trend) parts.push(`${idx}处于${A.trend.label}（收盘 ${fmtNum(M.close)} 点，较 MA60 ${fmtPct((M.close / M.ma60 - 1) * 100)}）`);
  if (A.breadth) parts.push(`宽度${A.breadth.label}（上涨占比 ${fmtNum(M.upRatio, 1)}%）`);
  if (A.liquidity) parts.push(`成交额${A.liquidity.label}（250 日 ${fmtNum(M.turnoverPct, 0)}% 分位）`);
  if (A.sentiment) parts.push(`情绪${A.sentiment.label}`);
  const findings = [];
  const add = (type, text, ids) => { const e = ids.filter(Boolean); if (e.length) findings.push({ type, text: sanitize(text).text, evidence: e }); }; // 快讯标题来自第三方，模板文本同样过合规过滤
  if (A.trend) add('fact', `${idx}收盘 ${fmtNum(M.close)} 点，近 60 日 ${fmtPct(M.r60)}，距 250 日高点 ${fmtPct(M.dd)}。`, [first('trend', /收盘/), first('trend', /区间涨跌/), first('trend', /区间位置/)]);
  if (A.breadth) add('fact', `全 A 上涨 ${M.up} 家、下跌 ${M.down} 家，个股涨跌幅中位数 ${fmtPct(M.medChg)}。`, [first('breadth', /涨跌家数/), first('breadth', /中位数/)]);
  if (A.liquidity) add('fact', `沪深两市成交额 ${fmtYi(M.turnover)}，处近 250 个交易日 ${fmtNum(M.turnoverPct, 0)}% 分位。`, [first('liquidity', /成交额$/), first('liquidity', /分位/)]);
  if (A.sentiment) add('fact', `涨停 ${M.limitUp} 家、跌停 ${M.limitDown ?? '—'} 家，封板率 ${fmtNum(M.sealRate, 1)}%。`, [first('sentiment', /涨跌停/)]);
  if (M.indTop?.length) add('fact', `近 20 日领涨行业为${M.indTop.slice(0, 3).map((x) => x.name).join('、')}。`, [first('industry', /领涨/)]);
  const rid = (a) => regimeEvidence(regime).find((x) => x.label === `${a.name}判定`)?.id;
  const why = {
    trend: () => `收盘${M.close > M.ma20 ? '高于' : '低于'} MA20、${M.close > M.ma60 ? '高于' : '低于'} MA60，MA20 位于 MA60 ${M.ma20 > M.ma60 ? '上方' : '下方'}，近 60 日 ${fmtPct(M.r60)}`,
    breadth: () => `上涨家数占比 ${fmtNum(M.upRatio, 1)}%，个股涨跌幅中位数 ${fmtPct(M.medChg)}`,
    liquidity: () => `成交额处近 250 个交易日 ${fmtNum(M.turnoverPct, 0)}% 分位`,
    sentiment: () => `涨停 ${M.limitUp} 家 / 跌停 ${M.limitDown ?? '—'} 家，封板率 ${fmtNum(M.sealRate, 1)}%${M.avgSeal10 != null ? `（此前均值 ${fmtNum(M.avgSeal10, 1)}%）` : ''}`,
    style: () => `近 20 日中证1000 相对沪深300 ${fmtNum(M.sizeSpread20)} 个百分点${M.growthSpread20 != null ? `，国证成长相对国证价值 ${fmtNum(M.growthSpread20)} 个百分点` : ''}`,
    industry: () => `行业 20 日收益离散度处近期 ${fmtNum(M.indDispPct, 0)}% 分位`,
  };
  for (const [k, a] of Object.entries(A)) add('inference', `${a.name}为「${a.label}」${a.score != null ? `（评分 ${a.score}）` : ''}：${why[k] ? why[k]() : a.rule}。`, [rid(a), ...(a.evidence || []).slice(0, 2)]);
  for (const a of Object.values(A).filter((x) => x.critical)) add('uncertain', `${a.name}评分 ${a.score} 接近阈值，标签可能在一两个交易日内翻转。`, [regimeEvidence(regime).find((x) => x.label === `${a.name}判定`)?.id]);
  for (const g of report.gaps.slice(0, 3)) add('uncertain', `${g.title}缺失（${g.reason}），该项未纳入判断。`, [ev.find((e) => e.kind === 'gap' && e.label.includes(g.title))?.id]);
  const news = ev.filter((e) => e.dim === 'events').slice(0, 2);
  if (news.length) add('uncertain', `近期事件（如「${news[0].label.replace(/^\[.*?\]\s*/, '').slice(0, 24)}」）对市场状态的影响尚无数据验证。`, news.map((n) => n.id));

  const sw = regime.switches.slice(0, 3);
  const focusAnswer = {
    overview: `当前判断为「${regime.name}」，置信度${regime.confidence.level}。主要矛盾是：${regime.main_contradiction.text}。判断会在以下条件出现时改变：${sw.map((s) => s.condition).join('；') || '暂无'}。`,
    style: A.style ? `风格上${A.style.label}。中证1000 相对沪深300 近 20 日差 ${fmtNum(M.sizeSpread20)} 个百分点，成长相对价值差 ${fmtNum(M.growthSpread20)} 个百分点；若比值跌破/站上 60 日均线，风格判断需要改变。` : '风格数据缺失，无法判断。',
    industry: A.industry ? `行业层面${A.industry.label}（离散度分位 ${fmtNum(M.indDispPct, 0)}%），近 20 日领涨为${(M.indTop || []).slice(0, 3).map((x) => x.name).join('、')}，领跌为${(M.indBottom || []).slice(0, 3).map((x) => x.name).join('、')}${M.themeTop?.length ? `；涨停题材集中在${M.themeTop.slice(0, 3).map((x) => x[0]).join('、')}` : ''}。` : '行业数据缺失，无法判断。',
    risk: `需要跟踪的风险变量：${[A.breadth && `宽度（上涨占比 ${fmtNum(M.upRatio, 1)}%）`, A.liquidity && `量能（${fmtNum(M.turnoverPct, 0)}% 分位）`, A.sentiment && `情绪（跌停 ${M.limitDown ?? '—'} 家、封板率 ${fmtNum(M.sealRate, 1)}%）`, A.trend && `波动率（20 日年化 ${fmtNum(M.vol20, 1)}%）`].filter(Boolean).join('、')}。数据缺口：${report.gaps.map((g) => g.title).join('、') || '无'}。`,
    history: report.analogs?.items?.length ? `近 5 年与当前特征最相似的阶段：${report.analogs.items.map((a) => a.date).join('、')}。这些阶段之后 20 个交易日的走势分化明显，说明相似的状态并不对应确定的后续方向，只能用来理解可能出现的情景范围。` : '历史日 K 不足，无法匹配相似阶段。',
  }[report.input.focus] || '';

  return {
    source: 'template',
    headline: `${regime.name}｜置信度${regime.confidence.level}`,
    summary: parts.join('；') + '。',
    findings,
    answer: focusAnswer,
    watch: sw.map((s, i) => ({ text: `${s.axis}：${s.condition}（当前 ${s.current}）`, evidence: [`C${i + 1}`] })),
  };
}
