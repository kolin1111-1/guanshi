// 极简 SVG 图表（零依赖）。颜色遵循 A 股习惯：红涨绿跌。
(function () {
  const W = 720;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nice = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: d }));

  function scale(min, max, a, b) { const k = max === min ? 0 : (b - a) / (max - min); return (v) => a + (v - min) * k; }
  function ticks(min, max, n = 4) { const out = []; for (let i = 0; i <= n; i++) out.push(min + (max - min) * i / n); return out; }

  /** 折线图：series = [{name, color, dash, points:[{d, v}]}]，共享 x（按日期索引） */
  function line({ series, height = 260, yFmt = (v) => nice(v, Math.abs(v) >= 100 ? 0 : 2), refs = [] }) {
    const H = height, L = 56, R = 12, T = 12, B = 26;
    const dates = series[0].points.map((p) => p.d);
    const all = series.flatMap((s) => s.points.map((p) => p.v)).concat(refs.map((r) => r.v)).filter((v) => v != null && isFinite(v));
    let min = Math.min(...all), max = Math.max(...all);
    const pad = (max - min) * 0.06 || 1; min -= pad; max += pad;
    const x = scale(0, dates.length - 1, L, W - R), y = scale(min, max, H - B, T);
    let g = '';
    for (const t of ticks(min, max)) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#eceff3"/><text x="${L - 6}" y="${y(t) + 4}" font-size="11" text-anchor="end" fill="#7d8696">${esc(yFmt(t))}</text>`;
    const idx = [0, Math.floor(dates.length / 3), Math.floor(dates.length * 2 / 3), dates.length - 1];
    for (const i of idx) g += `<text x="${x(i)}" y="${H - 6}" font-size="11" text-anchor="${i === 0 ? 'start' : i === dates.length - 1 ? 'end' : 'middle'}" fill="#7d8696">${esc(dates[i] || '')}</text>`;
    for (const r of refs) g += `<line x1="${L}" x2="${W - R}" y1="${y(r.v)}" y2="${y(r.v)}" stroke="${r.color || '#b26b00'}" stroke-dasharray="4 4"/><text x="${W - R}" y="${y(r.v) - 4}" font-size="11" text-anchor="end" fill="${r.color || '#b26b00'}">${esc(r.label)}</text>`;
    for (const s of series) {
      let d = '', pen = false;
      s.points.forEach((p, i) => { if (p.v == null || !isFinite(p.v)) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`; pen = true; });
      g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.8}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round"/>`;
    }
    // 悬停提示：每个日期一条透明竖条
    const step = (W - L - R) / Math.max(1, dates.length - 1);
    dates.forEach((d, i) => {
      const tip = [d, ...series.map((s) => `${s.name}：${yFmt(s.points[i]?.v)}`)].join('\n');
      g += `<rect x="${x(i) - step / 2}" y="${T}" width="${step}" height="${H - T - B}" fill="transparent"><title>${esc(tip)}</title></rect>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
  }

  /** 柱状图：items = [{label, n, color}] */
  function bars({ items, height = 240, fmt = (v) => nice(v, 0) }) {
    const H = height, L = 40, R = 10, T = 16, B = 28;
    const max = Math.max(1, ...items.map((i) => i.n));
    const y = scale(0, max, H - B, T);
    const bw = (W - L - R) / items.length;
    let g = '';
    for (const t of ticks(0, max)) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#eceff3"/><text x="${L - 6}" y="${y(t) + 4}" font-size="11" text-anchor="end" fill="#7d8696">${fmt(t)}</text>`;
    items.forEach((it, i) => {
      const x0 = L + i * bw + bw * 0.15, w = bw * 0.7;
      g += `<rect x="${x0}" y="${y(it.n)}" width="${w}" height="${H - B - y(it.n)}" fill="${it.color}" rx="2"><title>${esc(it.label)}：${fmt(it.n)}</title></rect>`;
      g += `<text x="${x0 + w / 2}" y="${y(it.n) - 4}" font-size="10.5" text-anchor="middle" fill="#4a5465">${fmt(it.n)}</text>`;
      g += `<text x="${x0 + w / 2}" y="${H - 9}" font-size="11" text-anchor="middle" fill="#7d8696">${esc(it.label)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
  }

  /** 横向正负条：items = [{name, v}]，单位 % */
  function hbars({ items, fmt = (v) => `${v > 0 ? '+' : ''}${nice(v, 1)}%` }) {
    const rowH = 22, T = 6, H = T * 2 + rowH * items.length, LBL = 110;
    const maxAbs = Math.max(0.1, ...items.map((i) => Math.abs(i.v)));
    const half = (W - LBL - 110) / 2;
    const mid = LBL + 55 + half;
    const k = half / maxAbs;
    let g = `<line x1="${mid}" x2="${mid}" y1="${T}" y2="${H - T}" stroke="#c9ced6"/>`;
    items.forEach((it, i) => {
      const yy = T + i * rowH;
      const w = Math.abs(it.v) * k;
      const x0 = it.v >= 0 ? mid : mid - w;
      const c = it.v >= 0 ? '#d23c3c' : '#1f8a4c';
      g += `<text x="${LBL - 8}" y="${yy + 15}" font-size="12" text-anchor="end" fill="#1c2330">${esc(it.name)}</text>`;
      g += `<rect x="${x0}" y="${yy + 4}" width="${Math.max(1, w)}" height="${rowH - 8}" fill="${c}" rx="2" opacity=".85"><title>${esc(it.name)}：${fmt(it.v)}</title></rect>`;
      g += `<text x="${it.v >= 0 ? x0 + w + 4 : x0 - 4}" y="${yy + 15}" font-size="11" text-anchor="${it.v >= 0 ? 'start' : 'end'}" fill="${c}">${fmt(it.v)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
  }

  /** 情绪：涨停/跌停柱 + 封板率折线（右轴 0~100%） */
  function sentiment({ rows, height = 260 }) {
    const H = height, L = 40, R = 44, T = 14, B = 26;
    const max = Math.max(10, ...rows.flatMap((r) => [r.up || 0, r.down || 0]));
    const y = scale(0, max, H - B, T), y2 = scale(0, 100, H - B, T);
    const bw = (W - L - R) / rows.length;
    let g = '';
    for (const t of ticks(0, max)) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#eceff3"/><text x="${L - 6}" y="${y(t) + 4}" font-size="11" text-anchor="end" fill="#7d8696">${nice(t, 0)}</text>`;
    for (const t of [0, 50, 100]) g += `<text x="${W - R + 6}" y="${y2(t) + 4}" font-size="11" fill="#b26b00">${t}%</text>`;
    let d = '';
    rows.forEach((r, i) => {
      const x0 = L + i * bw;
      const w = bw * 0.32;
      g += `<rect x="${x0 + bw * 0.16}" y="${y(r.up || 0)}" width="${w}" height="${H - B - y(r.up || 0)}" fill="#d23c3c" opacity=".85"><title>${r.d} 涨停 ${r.up} 家</title></rect>`;
      g += `<rect x="${x0 + bw * 0.52}" y="${y(r.down || 0)}" width="${w}" height="${H - B - y(r.down || 0)}" fill="#1f8a4c" opacity=".85"><title>${r.d} 跌停 ${r.down ?? '—'} 家</title></rect>`;
      if (r.seal != null) d += `${d ? 'L' : 'M'}${(x0 + bw / 2).toFixed(1)},${y2(r.seal).toFixed(1)}`;
      if (i % 2 === 0 || i === rows.length - 1) g += `<text x="${x0 + bw / 2}" y="${H - 8}" font-size="10.5" text-anchor="middle" fill="#7d8696">${esc(r.d.slice(5))}</text>`;
    });
    g += `<path d="${d}" fill="none" stroke="#b26b00" stroke-width="2"/>`;
    rows.forEach((r, i) => { if (r.seal != null) g += `<circle cx="${L + i * bw + bw / 2}" cy="${y2(r.seal)}" r="3" fill="#b26b00"><title>${r.d} 封板率 ${r.seal}%</title></circle>`; });
    return `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
  }

  window.Charts = { line, bars, hbars, sentiment };
})();
