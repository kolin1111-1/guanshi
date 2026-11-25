// 观势前端：提交研判 → 读取 NDJSON 事件流 → 渲染过程与报告
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (v, d = 2) => (v == null || !isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);
  const STATUS_TEXT = { ok: '正常', missing: '缺失', partial: '部分缺失', stale: '过期', conflict: '冲突' };
  const KIND_TEXT = { fact: '事实（原始字段或其统计）', derived: '推导指标（确定性计算）', gap: '数据缺口', inference: '规则判定' };
  const DIM_TEXT = { trend: '行情结构', breadth: '市场宽度', style: '风格轮动', industry: '行业结构', valuation: '估值', liquidity: '流动性', sentiment: '情绪', events: '重要事件', quality: '数据质量', regime: '状态判定', switch: '切换条件' };
  const TYPE_TEXT = { fact: '事实', inference: '归纳', uncertain: '不确定' };

  let META = null;
  let LAST = null; // 最近一次报告
  let running = false;
  const state = { steps: {}, plan: null };

  // ---------- 初始化 ----------
  async function init() {
    try {
      META = await (await fetch('/api/meta')).json();
    } catch {
      $('#report').innerHTML = `<div class="banner bad"><b>服务不可用</b>无法连接后端，请确认服务已启动。</div>`;
      return;
    }
    $('#index').innerHTML = META.indexes.map((i) => `<option value="${i.code}">${esc(i.name)}（${i.code}）</option>`).join('');
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const min = new Date(Date.now() + 8 * 3600e3 - 360 * 86400e3).toISOString().slice(0, 10);
    Object.assign($('#asof'), { max: today, min, value: '' });
    $('#asof').title = '留空 = 最新交易日；可回看过去一年内的某个交易日';
    $('#examples').innerHTML = META.examples.map((e) => `<button type="button" class="chip">${esc(e)}</button>`).join('');
    $('#examples').addEventListener('click', (e) => { if (e.target.classList.contains('chip')) { $('#q').value = e.target.textContent; } });
    $('#sims').innerHTML = Object.entries(META.simulations).map(([k, v]) => `<label><input type="checkbox" value="${k}">${esc(v)}</label>`).join('');
    $('#foot').textContent = META.disclaimer + ' 数据来源：扶摇 · 同花顺金融数据 API。';
    refreshHealth();
  }

  async function refreshHealth() {
    try {
      const h = await (await fetch('/api/health')).json();
      const d = $('#st-data');
      d.className = `pill ${h.fuyao.configured ? 'ok' : 'bad'}`;
      d.textContent = h.fuyao.configured ? '扶摇数据：已配置' : '扶摇数据：未配置 Key';
      const l = $('#st-llm');
      if (!h.llm.configured) { l.className = 'pill warn'; l.textContent = '大模型：未配置，规则模式'; }
      else if (h.llm.last?.ok === false) { l.className = 'pill warn'; l.textContent = `大模型：${h.llm.last.message}，已降级为规则模式`; l.title = h.llm.last.detail || h.llm.last.message; }
      else if (h.llm.last?.ok == null) { l.className = 'pill'; l.textContent = `大模型：${h.llm.model}（尚未调用）`; }
      else { l.className = 'pill ok'; l.textContent = `大模型：${h.llm.model}`; }
    } catch { /* 忽略 */ }
  }

  // ---------- 提交 ----------
  $('#form').addEventListener('submit', (e) => { e.preventDefault(); run('overview'); });

  async function run(focus) {
    if (running) return;
    running = true;
    $('#go').disabled = true;
    const body = {
      question: $('#q').value.trim(),
      index: $('#index').value,
      asOf: $('#asof').value || null,
      focus,
      simulate: [...document.querySelectorAll('#sims input:checked')].map((i) => i.value),
    };
    state.steps = {}; state.plan = null;
    renderWorkStart(body);
    $('#report').innerHTML = `<div class="card"><div class="stage"><span class="spin"></span><span id="r-stage">正在研判…</span></div></div>`;
    try {
      const res = await fetch('/api/research', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) onEvent(JSON.parse(line));
        }
      }
    } catch (err) {
      $('#report').innerHTML = `<div class="banner bad"><b>研判失败</b>${esc(err.message)}</div>`;
      setStage(null);
    } finally {
      running = false;
      $('#go').disabled = false;
      refreshHealth();
    }
  }

  function onEvent(e) {
    if (e.type === 'guard' && e.guard.flagged) {
      $('#report').insertAdjacentHTML('afterbegin', `<div class="banner warn"><b>已改写问题</b>${esc(e.guard.notice)}</div>`);
    } else if (e.type === 'stage') {
      setStage(e.text);
    } else if (e.type === 'plan') {
      state.plan = e.plan;
      renderPlan();
    } else if (e.type === 'step') {
      state.steps[e.tool] = e;
      renderPlan();
    } else if (e.type === 'report') {
      LAST = e.report;
      setStage(null);
      renderReport(e.report);
      renderTrace(e.report);
    } else if (e.type === 'fatal') {
      $('#report').innerHTML = `<div class="banner bad"><b>服务内部错误</b>${esc(e.message)}</div>`;
      setStage(null);
    }
  }

  // ---------- 侧栏：研判过程 ----------
  function renderWorkStart(body) {
    $('#work').innerHTML = `<h3>研判过程</h3>
      <div class="stage" id="w-stage"><span class="spin"></span><span>开始…</span></div>
      <div id="w-plan"></div><div id="w-trace"></div>`;
  }
  function setStage(text) {
    const el = $('#w-stage');
    if (el) el.innerHTML = text ? `<span class="spin"></span><span>${esc(text)}</span>` : '<span class="muted">完成</span>';
    const r = $('#r-stage');
    if (r && text) r.textContent = text;
  }
  function renderPlan() {
    const p = state.plan;
    if (!p) return;
    const icon = { running: '◌', done: '✓', error: '✕', unavailable: '!' };
    const plannerText = p.planner === 'llm' ? `<b>大模型规划</b>（${esc(p.llm?.model || '')}，${fmt(p.llm?.latency_ms / 1000, 1)} 秒）` : '<b>规则规划</b>（大模型不可用时的降级方案）';
    $('#w-plan').innerHTML = `
      <div class="planner">${plannerText}<div>${esc(p.intent)}</div>
        ${p.notes?.length ? `<ul class="notes">${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>
      <ol class="steps">${p.steps.map((s) => {
        const st = state.steps[s.tool];
        const status = st?.status || 'pending';
        let meta = '';
        if (st?.status === 'done') meta = `<div class="meta">${st.calls} 次调用${st.failed ? `，失败 ${st.failed}` : ''} · ${st.latency_ms} ms</div>`;
        if (st?.status === 'error') meta = `<div class="meta err">失败：${esc(st.note)}</div>`;
        if (st?.status === 'unavailable') meta = `<div class="meta una">不可用：${esc(st.note)}</div>`;
        return `<li><span class="ic ${status}">${icon[status] || '·'}</span><div><div class="ttl">${esc(s.title)}${s.added_by === 'system' ? ' <span class="muted">（系统补全）</span>' : ''}</div><div class="why">${esc(s.why)}</div>${meta}</div></li>`;
      }).join('')}</ol>`;
  }
  function renderTrace(r) {
    const s = r.stats;
    $('#w-trace').innerHTML = `
      <div class="stats"><div><b>${s.calls}</b>接口调用</div><div><b>${s.failed}</b>失败</div><div><b>${s.cached}</b>命中缓存</div><div><b>${fmt(s.elapsed_ms / 1000, 1)}s</b>总耗时</div></div>
      <details class="trace"><summary>调用明细（${r.trace.length} 条，可核对 request_id）</summary>
      <table><thead><tr><th>接口</th><th>结果</th><th>request_id</th><th>耗时</th></tr></thead><tbody>
      ${r.trace.map((p) => `<tr><td><code>${esc(p.endpoint.replace('/api/', ''))}</code></td><td>${p.status === 'error' ? `<span class="down" style="color:var(--bad)">${esc(String(p.code))}</span>` : esc(p.status === 'ok' ? '成功' : p.status === 'empty' ? '空' : p.status)}${p.cached ? '·缓存' : ''}</td><td><code>${esc((p.request_id || '—').slice(0, 12))}</code></td><td class="num">${p.latency_ms}ms</td></tr>`).join('')}
      </tbody></table></details>`;
  }

  // ---------- 报告 ----------
  function evChip(id, r) {
    const e = findEv(id, r);
    return `<span class="ev ${e && e.status === 'missing' ? 'missing' : ''}" data-ev="${esc(id)}" title="${esc(e ? e.label : id)}">${esc(id)}</span>`;
  }
  function findEv(id, r = LAST) {
    return r.evidence.find((e) => e.id === id) || r.regime_evidence?.find((e) => e.id === id);
  }

  function renderReport(r) {
    const n = r.narrative;
    const A = r.regime.axes;
    const parts = [];
    if (r.guard?.flagged) parts.push(`<div class="banner warn"><b>已改写问题</b>${esc(r.guard.notice)}</div>`);
    if (r.blocked) parts.push(`<div class="banner bad"><b>不输出研判结论</b>${esc(n.summary)}</div>`);
    if (r.stale) parts.push(`<div class="banner warn"><b>数据时点滞后</b>${esc(r.stale)}。相关结论的置信度已下调。</div>`);
    const conflicts = r.evidence.filter((e) => e.status === 'conflict');
    if (conflicts.length) parts.push(`<div class="banner warn"><b>数据冲突</b>${conflicts.map((c) => esc(c.display)).join('；')}</div>`);
    if (r.input.asOf) parts.push(`<div class="banner info"><b>历史时点回看</b>研判时点为 ${esc(r.trade_date)}。只有最新值的数据（全市场宽度、估值、快讯、热榜）在此模式下标记为缺失，不会用今天的数据冒充。</div>`);
    if (n.source === 'template' && n.fallback_reason) parts.push(`<div class="banner info"><b>文字由规则模板生成</b>大模型未参与本次叙述（${esc(n.fallback_reason)}）。状态判定、证据与置信度不受影响，它们本来就由确定性规则计算。</div>`);

    // 状态卡
    const conf = r.regime.confidence;
    const cl = conf.level === '高' ? 'high' : conf.level === '中' ? 'mid' : 'low';
    const srcBadge = n.source === 'llm' ? `<span class="src-badge llm">AI 叙述 · ${esc(n.model || '')} · 已通过引用与数值校验</span>` : n.source === 'template' ? '<span class="src-badge tpl">模板叙述</span>' : '';
    parts.push(`<section class="card state">
      <div>
        <div class="muted" style="font-size:12px">${esc(r.input.indexName)} · ${esc(r.input.focusName)}</div>
        <div class="state-name">${esc(r.regime.name)}</div>
        <div class="state-meta"><span>研判交易日 <b>${esc(r.trade_date)}</b></span><span>数据最新时间 <b>${esc(r.data_time || '—')}</b></span><span>${srcBadge}</span></div>
        <p class="state-summary">${esc(n.summary)}</p>
        <div class="axes">${Object.entries(A).map(([k, a]) => `<span class="axis ${a.score > 0.3 ? 'pos' : a.score < -0.3 ? 'neg' : ''}" data-axis="${k}" title="${esc(a.rule)}">${esc(a.name)}<b>${esc(a.label)}</b>${a.score != null ? `<span class="sc">${fmt(a.score)}</span>` : ''}</span>`).join('')}</div>
      </div>
      <div class="conf">
        <div class="muted" style="font-size:12px">置信度</div>
        <div class="conf-top"><span class="conf-level ${cl}">${esc(conf.level)}</span><span class="muted">${fmt(conf.value)}</span></div>
        <div class="meter"><i style="width:${Math.round(conf.value * 100)}%"></i></div>
        <ul class="reasons">${conf.reasons.map((x) => `<li class="${x.sign === '+' ? 'p' : 'm'}">${esc(x.text)}${(x.evidence || []).map((id) => ' ' + evChip(id, r)).join('')}</li>`).join('')}</ul>
        <div class="formula">${esc(conf.formula)}</div>
      </div>
    </section>`);

    if (!r.blocked) {
      // 主要矛盾 + 回答
      const mc = r.regime.main_contradiction;
      parts.push(`<section class="card contra">
        <div class="section-title"><h3>主要矛盾</h3><span class="muted">规则在多个候选张力中取最大者</span></div>
        <div class="contra-text">${esc(mc.text)} ${mc.evidence.map((id) => evChip(id, r)).join('')}</div>
        ${r.regime.other_tensions?.length ? `<ul class="contra-sub">${r.regime.other_tensions.map((t) => `<li>次要：${esc(t.text)}</li>`).join('')}</ul>` : ''}
        <div class="section-title" style="margin-top:14px"><h3>${r.guard?.flagged ? '针对改写后的问题' : r.input.question ? '回应你的问题' : '研判要点'}</h3></div>
        <p class="answer">${esc(n.answer)}</p>
      </section>`);

      // 三类结论
      const groups = { fact: [], inference: [], uncertain: [] };
      for (const f of n.findings) (groups[f.type] || groups.uncertain).push(f);
      const desc = { fact: '直接来自原始字段或其统计', inference: '由公开规则对多条事实归纳', uncertain: '信号冲突、临界或数据缺口' };
      const val = n.validation;
      parts.push(`<section class="card">
        <div class="section-title"><h3>结论与证据</h3><span class="muted">点击证据编号查看原始字段、来源接口、request_id 与时点</span></div>
        <div class="findings">${['fact', 'inference', 'uncertain'].map((t) => `<div class="fcol"><h4><span class="tag ${t}">${TYPE_TEXT[t]}</span><span class="muted" style="font-weight:400;font-size:11.5px">${desc[t]}</span></h4>
          ${groups[t].map((f) => `<div class="fitem">${esc(f.text)}<div class="evs">${f.evidence.map((id) => evChip(id, r)).join('')}</div></div>`).join('') || '<div class="muted" style="font-size:12px">无</div>'}</div>`).join('')}</div>
        ${val ? `<details class="validation"><summary>AI 输出校验：${val.passed}/${val.checked} 条通过，剔除 ${val.dropped.length} 条，拦截违规 ${val.violations.length} 句</summary><ul>${val.dropped.map((d) => `<li>剔除「${esc(d.text)}」——${esc(d.reason)}</li>`).join('')}${val.violations.map((v) => `<li>拦截「${esc(v.sentence)}」</li>`).join('')}</ul></details>` : ''}
      </section>`);

      // 切换条件
      parts.push(`<section class="card">
        <div class="section-title"><h3>状态切换条件</h3><span class="muted">可观测的触发条件，不是预测；出现时本页判断需要改变</span></div>
        <table><thead><tr><th>维度</th><th>从 → 到</th><th>触发条件</th><th>当前值</th><th>距离</th><th>证据</th></tr></thead><tbody>
        ${r.regime.switches.map((s) => `<tr><td>${esc(s.axis)}</td><td>${esc(s.from)} <span class="arrow">→</span> ${esc(s.to)}</td><td>${esc(s.condition)}</td><td class="num">${esc(s.current)}</td><td class="num">${esc(s.distance)}</td><td>${s.evidence.map((id) => evChip(id, r)).join('')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">无</td></tr>'}
        </tbody></table>
      </section>`);

      // 历史相似阶段
      if (r.analogs?.items?.length) {
        parts.push(`<section class="card">
          <div class="section-title"><h3>历史相似阶段</h3><span class="muted">${esc(r.analogs.method)}</span></div>
          <p class="chart-note" style="margin:0 0 10px">当前（${esc(r.analogs.current.date)}）：${esc(r.analogs.current.features_text)}</p>
          <div class="analogs">${r.analogs.items.map((a, i) => `<div class="analog"><h4>${esc(a.date)} <span class="muted" style="font-size:11px">相似度 ${fmt(a.similarity, 3)}</span></h4><p>${esc(a.features_text)}</p><p><b>${esc(a.after_text)}</b></p><div class="chart" style="min-height:0" id="an-${i}"></div></div>`).join('')}</div>
          <p class="chart-note">${esc(r.analogs.caveat)}</p>
        </section>`);
      }

      // 图表
      parts.push(`<section class="card">
        <div class="section-title"><h3>证据图表</h3></div>
        <div class="tabs" id="tabs"></div>
        <div class="chart" id="chart"></div>
        <p class="chart-note" id="chart-note"></p>
      </section>`);
    }

    // 证据清单
    const byDim = {};
    for (const e of r.evidence) (byDim[e.dim] = byDim[e.dim] || []).push(e);
    parts.push(`<section class="card">
      <div class="section-title"><h3>证据清单（${r.evidence.length} 条）</h3><span class="muted">缺口 ${r.gaps.length} 项 · 点击任一行查看溯源</span></div>
      <div class="evlist">${Object.entries(byDim).map(([d, list]) => `<div class="dimhead">${esc(DIM_TEXT[d] || d)}</div>` + list.map((e) => `<div class="evrow" data-ev="${esc(e.id)}"><span class="id">${esc(e.id)}</span><span class="lb">${esc(e.label)}${e.status !== 'ok' ? `<span class="st ${e.status}">${STATUS_TEXT[e.status] || e.status}</span>` : ''}</span><span>${esc(e.display)}</span><span class="t">${esc(e.as_of || '—')}</span></div>`).join('')).join('')}</div>
    </section>`);

    // 继续研究
    parts.push(`<section class="card">
      <div class="section-title"><h3>继续研究</h3><span class="muted">沿用当前对象、时点和问题，换一个方向重新取数</span></div>
      <div class="next">${Object.entries(META.focus).map(([k, v]) => `<button class="btn ${k === r.input.focus ? 'on' : ''}" data-focus="${k}">${esc(v.replace('继续研究：', ''))}</button>`).join('')}</div>
    </section>`);

    $('#report').innerHTML = parts.join('');
    if (!r.blocked) { renderCharts(r); renderAnalogCharts(r); }
  }

  // ---------- 图表 ----------
  function renderCharts(r) {
    const c = r.charts || {};
    const M = r.metrics || {};
    const tabs = [];
    if (c.trend) tabs.push(['trend', '指数与均线', () => [Charts.line({ series: [
      { name: c.trend.name, color: '#233a5e', points: c.trend.bars.map((b) => ({ d: b.d, v: b.c })) },
      { name: 'MA20', color: '#e0a03a', dash: '5 3', points: c.trend.bars.map((b, i) => ({ d: b.d, v: c.trend.ma20[i] })) },
      { name: 'MA60', color: '#9b59b6', dash: '5 3', points: c.trend.bars.map((b, i) => ({ d: b.d, v: c.trend.ma60[i] })) },
    ] }), `${legend([['#233a5e', c.trend.name], ['#e0a03a', 'MA20'], ['#9b59b6', 'MA60']])}近 160 个交易日收盘价（日 K close_price）。`]]);
    if (c.breadth) tabs.push(['breadth', '涨跌分布', () => [Charts.bars({ items: c.breadth.map((b) => ({ label: b.label, n: b.n, color: b.side === 'up' ? '#d23c3c' : b.side === 'down' ? '#1f8a4c' : '#8a93a3' })) }), `全 A 个股当日涨跌幅分布（单位：家；横轴为涨跌幅区间 %）。上涨 ${M.up} 家 / 下跌 ${M.down} 家。`]]);
    for (const k of ['size', 'growth']) {
      const s = c[`style_${k}`];
      if (s) tabs.push([k, k === 'size' ? '大小盘比值' : '成长价值比值', () => [Charts.line({ yFmt: (v) => fmt(v, 3), series: [
        { name: '比值', color: '#233a5e', points: s.series.map((p) => ({ d: p.d, v: p.v })) },
        { name: '60 日均线', color: '#e0a03a', dash: '5 3', points: s.series.map((p, i) => ({ d: p.d, v: s.ma60[i] })) },
      ] }), `${legend([['#233a5e', '比值'], ['#e0a03a', '60 日均线']])}${esc(s.label)}：收盘价比值，上升代表前者相对走强。`]]);
    }
    if (c.industry) tabs.push(['industry', '行业 20 日', () => [Charts.hbars({ items: [...c.industry.top, ...c.industry.bottom.slice().reverse()] }), '同花顺二级行业指数近 20 个交易日涨跌幅：领涨 8 个与领跌 8 个（红涨绿跌）。']]);
    if (c.liquidity) tabs.push(['liquidity', '两市成交额', () => [Charts.line({ yFmt: (v) => `${fmt(v / 10000, 1)}万亿`, refs: M.turnoverQ50 ? [{ v: M.turnoverQ50 / 1e8, label: '250 日中位数' }] : [], series: [{ name: '成交额（亿元）', color: '#3b5b8c', points: c.liquidity.map((p) => ({ d: p.d, v: p.v })) }] }), '上证指数 + 深证成指当日成交额（亿元），虚线为近 250 个交易日中位数。']]);
    if (c.sentiment) tabs.push(['sentiment', '涨跌停与封板率', () => [Charts.sentiment({ rows: c.sentiment }), `${legend([['#d23c3c', '涨停家数'], ['#1f8a4c', '跌停家数'], ['#b26b00', '封板率（右轴）']])}近 10 个交易日。`]]);
    if (c.indexTable) tabs.push(['table', '宽基对比', () => [`<table><thead><tr><th>指数</th><th>收盘</th><th>当日</th><th>20 日</th><th>60 日</th><th>日期</th></tr></thead><tbody>${c.indexTable.map((x) => `<tr><td>${esc(x.name)} <span class="muted">${x.code}</span></td><td class="num">${fmt(x.close)}</td>${[x.r1, x.r20, x.r60].map((v) => `<td class="num ${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${pct(v)}</td>`).join('')}<td class="num">${esc(x.d)}</td></tr>`).join('')}</tbody></table>`, '指数日 K 收盘价计算的区间涨跌幅。']]);
    if (!tabs.length) { $('#chart').innerHTML = '<p class="muted">没有可绘制的数据。</p>'; return; }
    const show = (key) => {
      const t = tabs.find((x) => x[0] === key) || tabs[0];
      const [svg, note] = t[2]();
      $('#chart').innerHTML = svg;
      $('#chart-note').innerHTML = note;
      document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t[0]));
    };
    $('#tabs').innerHTML = tabs.map((t) => `<button class="tab" data-tab="${t[0]}">${t[1]}</button>`).join('');
    $('#tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) show(e.target.dataset.tab); });
    show({ style: 'size', industry: 'industry', risk: 'sentiment', history: 'trend' }[r.input.focus] || 'trend');
  }
  const legend = (items) => `<div class="legend">${items.map(([c, n]) => `<span><i style="background:${c}"></i>${esc(n)}</span>`).join('')}</div>`;

  function renderAnalogCharts(r) {
    (r.analogs?.items || []).forEach((a, i) => {
      const el = document.getElementById(`an-${i}`);
      if (!el) return;
      const idx = a.path.findIndex((p) => p.d === a.date);
      el.innerHTML = Charts.line({ height: 150, series: [
        { name: '此前', color: '#233a5e', points: a.path.map((p, j) => ({ d: p.d, v: j <= idx ? p.c : null })) },
        { name: '之后 20 日', color: '#b26b00', points: a.path.map((p, j) => ({ d: p.d, v: j >= idx ? p.c : null })) },
      ] });
    });
  }

  // ---------- 证据抽屉 ----------
  function openEvidence(id) {
    const e = findEv(id);
    if (!e) return;
    const s = e.source || {};
    const refs = (e.refs || []).map((x) => evChip(x, LAST)).join('');
    $('#drawer-body').innerHTML = `
      <div class="muted" style="font-size:12px">${esc(DIM_TEXT[e.dim] || e.dim)} · ${esc(KIND_TEXT[e.kind] || e.kind)}</div>
      <h3 style="margin-top:4px">${esc(e.id)} · ${esc(e.label)} ${e.status && e.status !== 'ok' ? `<span class="st ${e.status}">${STATUS_TEXT[e.status] || e.status}</span>` : ''}</h3>
      <div class="big">${esc(e.display)}</div>
      <dl class="kv">
        ${e.value != null ? `<dt>数值</dt><dd>${esc(e.value)} ${esc(e.unit || '')}</dd>` : ''}
        <dt>时点</dt><dd>${esc(e.as_of || '—')}</dd>
        ${e.method ? `<dt>口径</dt><dd>${esc(e.method)}</dd>` : ''}
        ${s.tool ? `<dt>来源工具</dt><dd>${esc(s.tool)}</dd>` : ''}
        ${s.endpoints?.length ? `<dt>接口</dt><dd>${s.endpoints.map((x) => `<code>${esc(x)}</code>`).join('<br>')}</dd>` : ''}
        ${s.fields?.length ? `<dt>原始字段</dt><dd>${s.fields.map((x) => `<code>${esc(x)}</code>`).join(' ')}</dd>` : ''}
        ${s.request_ids?.length ? `<dt>request_id</dt><dd>${s.request_ids.map((x) => `<code>${esc(x)}</code>`).join('<br>')}</dd>` : ''}
        ${s.calls != null ? `<dt>调用次数</dt><dd>${s.calls} 次${s.failed_calls ? `，失败 ${s.failed_calls} 次` : ''}</dd>` : ''}
        ${s.url ? `<dt>原文</dt><dd><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">打开资讯原文</a></dd>` : ''}
        ${refs ? `<dt>依据证据</dt><dd>${refs}</dd>` : ''}
      </dl>
      <p class="chart-note" style="margin-top:16px">来源：扶摇 · 同花顺金融数据 API。时间均为北京时间。</p>`;
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
  }
  document.addEventListener('click', (e) => {
    const ev = e.target.closest('[data-ev]');
    if (ev && LAST) { openEvidence(ev.dataset.ev); return; }
    if (e.target.closest('[data-close]')) { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); return; }
    const f = e.target.closest('[data-focus]');
    if (f) { run(f.dataset.focus); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const ax = e.target.closest('[data-axis]');
    if (ax && LAST) { const a = LAST.regime.axes[ax.dataset.axis]; const rid = LAST.regime_evidence.find((x) => x.label === `${a.name}判定`)?.id; if (rid) openEvidence(rid); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#drawer').classList.remove('open'); });

  init();
})();
