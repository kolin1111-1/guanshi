// 观势 · HTTP 服务（零依赖 Node 20）
// GET  /                 前端
// GET  /api/health       数据源 / 模型状态
// GET  /api/meta         研判对象、追问方向、故障演练选项、工具目录
// POST /api/research     NDJSON 流：guard → plan → step* → stage* → report
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './src/config.js';
import { FuyaoClient } from './src/fuyao.js';
import { LLMClient } from './src/llm.js';
import { runResearch, validateInput, SIMULATIONS } from './src/research.js';
import { TARGET_INDEXES, INDEX_NAMES, toolCatalog } from './src/tools.js';
import { FOCUS } from './src/planner.js';
import { DISCLAIMER } from './src/compliance.js';

const client = new FuyaoClient({ apiKey: config.fuyao.apiKey, baseUrl: config.fuyao.baseUrl });
const llm = new LLMClient(config.llm);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const PUB = path.join(config.root, 'public');

// 简单的按 IP 限流，保护服务端持有的 API Key
const hits = new Map();
function allow(ip, limit = 12, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) { hits.set(ip, arr); return false; }
  arr.push(now); hits.set(ip, arr);
  return true;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req, max = 20000) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > max) throw new Error('请求体过大'); }
  return s ? JSON.parse(s) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, {
        fuyao: { configured: Boolean(config.fuyao.apiKey) },
        llm: { configured: llm.configured, model: config.llm.model, base: config.llm.baseUrl.replace(/^https?:\/\//, ''), last: llm.lastStatus },
        time: Date.now(),
      });
    }
    if (url.pathname === '/api/meta') {
      return json(res, 200, {
        indexes: TARGET_INDEXES.map((c) => ({ code: c, name: INDEX_NAMES[c] })),
        focus: FOCUS,
        simulations: SIMULATIONS,
        tools: toolCatalog(),
        disclaimer: DISCLAIMER,
        examples: [
          '指数在涨但我的股票都在跌，现在市场到底是什么状态？',
          '最近是大盘股行情还是小盘股行情？风格会不会切换？',
          '成交额缩量了吗？情绪是在升温还是降温？',
          '明天大盘会涨吗？现在该加仓吗？',
        ],
      });
    }
    if (url.pathname === '/api/research' && req.method === 'POST') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
      if (!allow(ip)) return json(res, 429, { error: '请求过于频繁，请一分钟后再试' });
      let body;
      try { body = await readBody(req); } catch (e) { return json(res, 400, { error: `请求格式错误：${e.message}` }); }
      const input = validateInput(body);
      if (input.error) return json(res, 400, { error: input.error });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const emit = (evt) => res.write(JSON.stringify(evt) + '\n');
      try {
        await runResearch({ client, llm, input, emit });
      } catch (e) {
        console.error(e);
        emit({ type: 'fatal', message: `服务内部错误：${e.message}` });
      }
      return res.end();
    }
    // 静态文件
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(PUB, path.normalize(p));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: '未找到' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(config.port, () => {
  console.log(`观势已启动：http://localhost:${config.port}`);
  console.log(`扶摇 API：${config.fuyao.apiKey ? '已配置' : '未配置（所有取数会失败并如实展示）'}；大模型：${llm.configured ? `${config.llm.model} @ ${config.llm.baseUrl}` : '未配置（降级为规则规划 + 模板叙述）'}`);
});
