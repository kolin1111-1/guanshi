// 扶摇客户端：信封校验、溯源字段、错误码、限流重试、超时、缺 Key、缓存、故障演练
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FuyaoClient } from '../src/fuyao.js';
import { FAKE_KEY, envelope, jsonResponse, hangingFetch } from './helpers.js';

const BASE = 'http://mock.fuyao';
const PATH = '/api/a-share-index/prices/snapshot';

test('成功信封：返回数据并生成完整溯源记录，Key 只走请求头', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return jsonResponse({ code: 0, message: 'success', request_id: 'rid-123', data: { timestamp: 1700000000000, item: [{ thscode: '000001.SH', last_price: 3000 }] } }); };
  const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl });
  const trace = [];
  const r = await c.get(PATH, { thscodes: '000001.SH' }, { tool: 'index_snapshot', trace });
  assert.equal(r.ok, true);
  assert.equal(r.data.item[0].last_price, 3000);
  assert.equal(r.prov.status, 'ok');
  assert.equal(r.prov.request_id, 'rid-123');
  assert.equal(r.prov.data_timestamp, 1700000000000);
  assert.equal(r.prov.tool, 'index_snapshot');
  assert.equal(r.prov.endpoint, PATH);
  assert.equal(r.prov.code, 0);
  assert.equal(trace.length, 1, '每次调用都要写入调用轨迹');
  assert.equal(seen.opts.headers['X-api-key'], FAKE_KEY);
  assert.ok(!seen.url.includes(FAKE_KEY), 'Key 不能出现在 URL 中');
  assert.ok(!r.prov.url_no_key.includes(FAKE_KEY));
});

test('空结果：code=0 但 item 为空时状态为 empty，而不是 ok', async () => {
  const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: async () => jsonResponse(envelope({ timestamp: null, item: [] })) });
  const r = await c.get(PATH, {});
  assert.equal(r.ok, true);
  assert.equal(r.prov.status, 'empty');
});

for (const [code, keyword] of [[2004, 'AI客户端专用'], [2001, 'API Key'], [5003, '数据源不可用']]) {
  test(`业务错误 code=${code}：返回结构化错误且不抛异常`, async () => {
    const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: async () => jsonResponse({ code, message: '上游原文[链接](https://example.org)', request_id: 'rid-e', data: null }) });
    const r = await c.get(PATH, {});
    assert.equal(r.ok, false);
    assert.equal(r.data, null);
    assert.equal(r.prov.status, 'error');
    assert.equal(r.prov.code, code);
    assert.ok(r.prov.message.includes(keyword), r.prov.message);
    assert.ok(!r.prov.message.includes('（上游原文'), '已知错误码的提示不应重复拼接原文');
    assert.equal(r.prov.request_id, 'rid-e');
  });
}

test('HTTP 429 限流：退避后只重试一次，第二次成功', async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? jsonResponse({ code: 4001, message: 'rate limited' }, 429) : jsonResponse(envelope({ timestamp: 1, item: [1] })));
  const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl });
  const r = await c.get(PATH, {});
  assert.equal(n, 2);
  assert.equal(r.ok, true);
});

test('连续限流：重试一次后仍失败，返回 4001 错误', async () => {
  let n = 0;
  const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: async () => { n++; return jsonResponse({ code: 4001, message: 'rate limited' }, 429); } });
  const r = await c.get(PATH, {});
  assert.equal(n, 2, '只重试一次，不无限重试');
  assert.equal(r.ok, false);
  assert.equal(r.prov.code, 4001);
});

test('超时：fetch 挂起时按 timeoutMs 取消并返回 TIMEOUT', async () => {
  const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: hangingFetch(), timeoutMs: 40 });
  const t0 = Date.now();
  const r = await c.get(PATH, {});
  assert.equal(r.ok, false);
  assert.equal(r.prov.code, 'TIMEOUT');
  assert.ok(Date.now() - t0 < 2000);
});

test('网络错误：返回 NETWORK，不抛异常', async () => {
  const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  const r = await c.get(PATH, {});
  assert.equal(r.prov.code, 'NETWORK');
});

test('非 JSON 响应：返回 BAD_JSON', async () => {
  const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: async () => new Response('<html>502</html>', { status: 502 }) });
  const r = await c.get(PATH, {});
  assert.equal(r.prov.code, 'BAD_JSON');
});

test('未配置 Key：不发请求，直接返回 NO_KEY', async () => {
  let called = false;
  const c = new FuyaoClient({ apiKey: '', baseUrl: BASE, fetchImpl: async () => { called = true; return jsonResponse(envelope({})); } });
  const r = await c.get(PATH, {});
  assert.equal(called, false);
  assert.equal(r.prov.code, 'NO_KEY');
});

test('缓存：同一 URL 第二次命中缓存，cached=true 且不再发请求', async () => {
  let n = 0;
  const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: async () => { n++; return jsonResponse(envelope({ timestamp: 1, item: [1] })); } });
  await c.get(PATH, { a: 1 });
  const r2 = await c.get(PATH, { a: 1 });
  assert.equal(n, 1);
  assert.equal(r2.prov.cached, true);
  await c.get(PATH, { a: 2 });
  assert.equal(n, 2, '参数不同不能命中缓存');
});

test('错误结果不进缓存：失败后再次请求会重新调用', async () => {
  let n = 0;
  const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: async () => { n++; return n === 1 ? jsonResponse(envelope(null, 5003, 'x')) : jsonResponse(envelope({ item: [1] })); } });
  const r1 = await c.get(PATH, {});
  const r2 = await c.get(PATH, {});
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, true);
  assert.equal(n, 2);
});

test('故障演练 fuyao_down / simulateTag：不发请求，返回 SIMULATED', async () => {
  let called = false;
  const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: async () => { called = true; return jsonResponse(envelope({})); } });
  const r = await c.get(PATH, {}, { simulate: new Set(['fuyao_down']) });
  assert.equal(r.prov.code, 'SIMULATED');
  const r2 = await c.get(PATH, {}, { simulate: new Set(['breadth_missing']), simulateTag: 'breadth_missing' });
  assert.equal(r2.prov.code, 'SIMULATED');
  const r3 = await c.get(PATH, {}, { simulate: new Set(['breadth_missing']) });
  assert.equal(r3.ok, true, '未打标签的调用不受 breadth_missing 影响');
  assert.equal(called, true);
});

test('故障演练 fuyao_timeout：返回 TIMEOUT', async () => {
  const c = new FuyaoClient({ apiKey: FAKE_KEY, baseUrl: BASE, fetchImpl: hangingFetch() });
  const r = await c.get(PATH, {}, { simulate: new Set(['fuyao_timeout']) });
  assert.equal(r.prov.code, 'TIMEOUT');
});
