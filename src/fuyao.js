// 扶摇（同花顺金融数据 API）客户端
// 职责：鉴权、超时、限流重试、信封校验、缓存，以及为每次调用生成「溯源记录」（provenance）。
// 任何失败都返回结构化错误，绝不抛出“空的正常结果”。
import { sleep } from './util.js';

export const ERROR_TEXT = {
  NO_KEY: '未配置 FUYAO_API_KEY',
  TIMEOUT: '请求超时',
  NETWORK: '网络错误',
  BAD_JSON: '响应无法解析',
  SIMULATED: '故障演练：模拟接口失败',
  1001: '缺少必填参数',
  1002: '参数格式错误',
  1003: '参数取值越界',
  1004: '参数冲突',
  2001: 'API Key 无效或缺失',
  2003: 'API Key 无权访问该能力',
  2004: '该数据为同花顺AI客户端专用，外部不可调用',
  3001: '标的不存在',
  3002: '数据未就绪',
  3004: '标的类型不支持该能力',
  4001: '触发限流',
  5001: '服务内部错误',
  5002: '上游服务超时',
  5003: '数据源不可用',
};

export class FuyaoClient {
  /**
   * @param {object} o
   * @param {string} o.apiKey
   * @param {string} [o.baseUrl]
   * @param {Function} [o.fetchImpl] 便于测试注入模拟 fetch
   * @param {number} [o.timeoutMs]
   */
  constructor({ apiKey, baseUrl = 'https://fuyao.aicubes.cn', fetchImpl = globalThis.fetch, timeoutMs = 15000, cacheTtlMs = 180000 } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();
  }

  /**
   * 调用一个 REST 端点。
   * @param {string} path 例如 /api/a-share-index/prices/snapshot
   * @param {object} params query 参数
   * @param {object} ctx { simulate:Set, trace:Array, tool:string, ttlMs?:number }
   * @returns {Promise<{ok:boolean, data:any, prov:object}>}
   */
  async get(path, params = {}, ctx = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const prov = {
      source: '扶摇·同花顺金融数据 API',
      tool: ctx.tool || null,
      endpoint: path,
      params,
      url_no_key: url, // 只含 query，不含 Key（Key 走请求头）
      request_id: null,
      http: null,
      code: null,
      message: null,
      data_timestamp: null,
      fetched_at: Date.now(),
      latency_ms: 0,
      cached: false,
      status: 'pending',
    };
    const t0 = Date.now();
    const finish = (status, extra = {}) => {
      Object.assign(prov, extra, { status, latency_ms: Date.now() - t0 });
      if (ctx.trace) ctx.trace.push(prov);
      return prov;
    };
    const sim = ctx.simulate || new Set();

    if (sim.has('fuyao_down') || (ctx.simulateTag && sim.has(ctx.simulateTag))) {
      return { ok: false, data: null, prov: finish('error', { code: 'SIMULATED', message: ERROR_TEXT.SIMULATED }) };
    }
    if (!this.apiKey) {
      return { ok: false, data: null, prov: finish('error', { code: 'NO_KEY', message: ERROR_TEXT.NO_KEY }) };
    }

    const cacheKey = url;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      return { ok: true, data: hit.data, prov: finish('ok', { ...hit.meta, cached: true, fetched_at: hit.fetched_at }) };
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      let res, text;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), sim.has('fuyao_timeout') ? 1 : this.timeoutMs);
      try {
        if (sim.has('fuyao_timeout')) await sleep(5);
        res = await this.fetchImpl(url, { headers: { 'X-api-key': this.apiKey, Accept: 'application/json' }, signal: ac.signal });
        text = await res.text();
      } catch (e) {
        clearTimeout(timer);
        const isTimeout = e?.name === 'AbortError';
        return { ok: false, data: null, prov: finish('error', { code: isTimeout ? 'TIMEOUT' : 'NETWORK', message: isTimeout ? ERROR_TEXT.TIMEOUT : `${ERROR_TEXT.NETWORK}：${e?.message || e}` }) };
      }
      clearTimeout(timer);

      let j = null;
      try { j = JSON.parse(text); } catch { /* 下面处理 */ }
      const rateLimited = res.status === 429 || j?.code === 4001;
      if (rateLimited && attempt === 0) { await sleep(900); continue; } // 限流：退避后只重试一次
      if (!j) return { ok: false, data: null, prov: finish('error', { http: res.status, code: 'BAD_JSON', message: ERROR_TEXT.BAD_JSON }) };

      const meta = {
        http: res.status,
        code: j.code,
        message: j.code === 0 ? 'success' : (ERROR_TEXT[j.code] || String(j.message || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')),
        raw_message: j.code === 0 ? undefined : j.message,
        request_id: j.request_id || null,
        data_timestamp: j?.data?.timestamp ?? null,
      };
      if (j.code !== 0) return { ok: false, data: null, prov: finish('error', meta) };

      const items = j.data?.item ?? j.data?.items;
      const empty = j.data == null || (Array.isArray(items) && items.length === 0);
      this.cache.set(cacheKey, { data: j.data, meta, fetched_at: prov.fetched_at, expires: Date.now() + (ctx.ttlMs ?? this.cacheTtlMs) });
      return { ok: true, data: j.data, prov: finish(empty ? 'empty' : 'ok', meta) };
    }
    return { ok: false, data: null, prov: finish('error', { code: 4001, message: ERROR_TEXT[4001] }) };
  }
}
