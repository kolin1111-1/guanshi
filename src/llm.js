// 大模型客户端（OpenAI 兼容协议：DeepSeek / 通义 / OpenAI / 本地 Ollama 均可）
// 任何失败都返回结构化错误，由调用方降级为规则模式，绝不阻塞主链路。

const ERR = {
  NO_KEY: '未配置 LLM_API_KEY',
  401: 'API Key 无效',
  402: '账户余额不足',
  429: '触发限流',
  TIMEOUT: '请求超时',
  NETWORK: '网络错误',
  BAD_JSON: '模型输出不是合法 JSON',
  SIMULATED: '故障演练：模拟模型不可用',
};

export class LLMClient {
  constructor({ apiKey, baseUrl, model, fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || '').replace(/\/$/, '');
    this.model = model;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.lastStatus = apiKey ? { ok: null, message: '尚未调用' } : { ok: false, code: 'NO_KEY', message: ERR.NO_KEY };
  }

  get configured() { return Boolean(this.apiKey && this.baseUrl && this.model); }

  /** 请求一个 JSON 对象输出 */
  async chatJSON({ system, user, maxTokens = 1800, temperature = 0.2, simulate = new Set() }) {
    const t0 = Date.now();
    const fail = (code, message, detail) => {
      this.lastStatus = { ok: false, code, message, detail, at: Date.now() };
      return { ok: false, error: { code, message, detail }, latency_ms: Date.now() - t0 };
    };
    if (simulate.has('llm_down')) return fail('SIMULATED', ERR.SIMULATED);
    if (!this.configured) return fail('NO_KEY', ERR.NO_KEY);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res, body;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      body = await res.json().catch(() => null);
    } catch (e) {
      clearTimeout(timer);
      return fail(e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', e?.name === 'AbortError' ? ERR.TIMEOUT : `${ERR.NETWORK}：${e?.message}`);
    }
    clearTimeout(timer);
    if (!res.ok) return fail(res.status, ERR[res.status] || `HTTP ${res.status}`, body?.error?.message);
    const content = body?.choices?.[0]?.message?.content;
    let json = null;
    try { json = JSON.parse(String(content).replace(/^```(json)?|```$/g, '').trim()); } catch { /* */ }
    if (!json) return fail('BAD_JSON', ERR.BAD_JSON);
    this.lastStatus = { ok: true, message: '可用', at: Date.now() };
    return { ok: true, json, usage: body.usage || null, model: body.model || this.model, latency_ms: Date.now() - t0 };
  }
}
