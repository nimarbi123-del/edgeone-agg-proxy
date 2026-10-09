// 本地端到端测试：用假上游验证 3 个 EdgeOne 函数的路由、鉴权、SSE 转换。
// 运行： node tests/local-test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { CHANNELS } from '../functions/_shared/channels.js';
import { onRequest as modelsFn } from '../functions/v1/models/index.js';
import { onRequest as chatFn } from '../functions/v1/chat/completions/index.js';
import { onRequest as responsesFn } from '../functions/v1/responses/index.js';

const PORT = 18081;
const KEY = 'test-key-123';

const TEXT = 'Hello from mock upstream.';
const CALL_ID = 'call_mock_1';

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const auth = req.headers.authorization || '';
    if (body.model === 'u2-flash' && auth !== 'Bearer key-unisound') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
      return;
    }
    if (body.model === 'glm-5.3-flash') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '余额不足', type: 'rate_limit' } }));
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (d) => res.write('data: ' + JSON.stringify(d) + '\n\n');
      chunk({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
      for (const piece of TEXT.match(/.{1,7}/g)) chunk({ choices: [{ index: 0, delta: { content: piece } }] });
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: CALL_ID, type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }] });
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: TEXT }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }));
  });
});

await new Promise((r) => mock.listen(PORT, '127.0.0.1', r));
mock.unref();
for (const c of CHANNELS) c.urls = ['http://127.0.0.1:' + PORT + '/chat/completions'];

const env = {
  EO_PROXY_KEY: KEY,
  EO_KEY_VOLCENGINE_ARK: 'key-ark',
  EO_KEY_AGNES: 'key-agnes',
  EO_KEY_ZHIPU: 'key-zhipu',
  EO_KEY_SAIL: 'key-sail',
  EO_KEY_OPENROUTER: 'key-or',
  EO_KEY_UNISOUND: 'key-unisound',
};

const base = 'https://agg.edgeonepage.com';
const call = (fn, path, init) => fn({ request: new Request(base + path, init), env, params: {} });

let pass = 0;
const ok = (name, extra) => { pass++; console.log('PASS  ' + name + (extra ? '  ' + extra : '')); };

// 1. /v1/models
{
  const res = await call(modelsFn, '/v1/models', { headers: { authorization: 'Bearer ' + KEY } });
  const j = await res.json();
  assert.equal(res.status, 200);
  const ids = j.data.map((m) => m.id);
  assert.equal(j.data.length, 13, 'unique model count');
  assert.ok(ids.includes('space-bunny-free'));
  assert.ok(ids.includes('glm-5.3-flash'));
  assert.ok(!ids.includes('doubao-seedream-5.0-pro'));
  ok('/v1/models', ids.length + ' models');
}

// 2. 鉴权：无 key / 错 key
{
  const noKey = await call(modelsFn, '/v1/models', {});
  assert.equal(noKey.status, 401);
  const badKey = await call(modelsFn, '/v1/models', { headers: { authorization: 'Bearer wrong' } });
  assert.equal(badKey.status, 401);
  ok('auth 拦截 401');
}

// 3. /v1/chat/completions 非流式透传
{
  const res = await call(chatFn, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: 'space-bunny-free', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.choices[0].message.content, TEXT);
  ok('/v1/chat/completions 非流式');
}

// 4. /v1/chat/completions 流式透传
{
  const res = await call(chatFn, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: 'agnes-3.0-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /event-stream/);
  const text = await res.text();
  assert.ok(text.includes('[DONE]'));
  assert.ok(text.includes('Hello'));
  ok('/v1/chat/completions 流式透传');
}

// 5. 上游 429 原样透传
{
  const res = await call(chatFn, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 429);
  ok('上游 429 透传');
}

// 6. 未知模型 404
{
  const res = await call(chatFn, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: 'gpt-9-不存在', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 404);
  ok('未知模型 404');
}

// 7. /v1/responses 非流式
{
  const res = await call(responsesFn, '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: 'space-bunny-free', input: 'hi', stream: false, instructions: 'be brief' }),
  });
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(j.object, 'response');
  assert.equal(j.status, 'completed');
  assert.equal(j.output_text, TEXT);
  assert.equal(j.usage.total_tokens, 8);
  assert.equal(j.output[0].content[0].text, TEXT);
  ok('/v1/responses 非流式');
}

// 8. /v1/responses 流式事件序列
{
  const res = await call(responsesFn, '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: 'space-bunny-free',
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read a.txt' }] },
      ],
      tools: [{ type: 'function', name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      tool_choice: 'auto',
      stream: true,
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /event-stream/);
  const raw = await res.text();
  const events = raw
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const line = b.split('\n').find((l) => l.startsWith('data:'));
      return JSON.parse(line.slice(5).trim());
    });
  const types = events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 2), ['response.created', 'response.in_progress']);
  assert.equal(types[types.length - 1], 'response.completed');
  assert.ok(types.includes('response.output_item.added'));
  assert.ok(types.includes('response.content_part.added'));
  assert.ok(types.includes('response.output_text.delta'));
  assert.ok(types.includes('response.output_text.done'));
  assert.ok(types.includes('response.content_part.done'));
  assert.ok(types.includes('response.output_item.done'));
  assert.ok(types.includes('response.function_call_arguments.delta'));
  assert.ok(types.includes('response.function_call_arguments.done'));
  const seqs = events.map((e) => e.sequence_number);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'sequence_number 必须 1..N 连续');
  const text = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
  assert.equal(text, TEXT);
  const args = events.filter((e) => e.type === 'response.function_call_arguments.delta').map((e) => e.delta).join('');
  assert.equal(args, '{"path":"a.txt"}');
  const done = events[events.length - 1].response;
  assert.equal(done.status, 'completed');
  assert.equal(done.output.length, 2);
  const fc = done.output.find((o) => o.type === 'function_call');
  assert.equal(fc.name, 'read_file');
  assert.equal(fc.arguments, '{"path":"a.txt"}');
  assert.equal(fc.call_id, CALL_ID);
  ok('/v1/responses 流式事件序列', events.length + ' events');

  // 转成 Chat 请求的检查：instructions→system，function_call_output→tool
  const { toChatMessages, toChatTools } = await import('../functions/v1/responses/index.js');
  const msgs = toChatMessages({
    instructions: 'sys',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'file body' },
    ],
  });
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].content, 'q');
  assert.equal(msgs[2].tool_calls[0].function.name, 'read_file');
  assert.equal(msgs[3].role, 'tool');
  assert.equal(msgs[3].tool_call_id, 'c1');
  const tools = toChatTools({ tools: [{ type: 'function', name: 'f', parameters: { type: 'object' } }] });
  assert.equal(tools[0].function.name, 'f');
  ok('Responses→Chat 请求转换');
}

// 9. EO_PROXY_KEY 未设置时放行 + 告警头
{
  const res = await modelsFn({ request: new Request(base + '/v1/models'), env: {}, params: {} });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('x-proxy-warning'));
  ok('EO_PROXY_KEY 未设置→放行+告警');
}

mock.closeAllConnections();
mock.close();
console.log('\nALL PASS (' + pass + ' checks)');
