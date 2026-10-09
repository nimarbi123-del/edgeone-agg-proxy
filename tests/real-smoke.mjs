// 真实上游冒烟测试（本机跑，不部署）：读 secrets.local.json，用真实密钥打真实上游，
// 验证 1) 渠道表与 secrets 是否一致 2) chat 非流式 3) Responses SSE 转换在真实数据上成立。
// 运行： node tests/real-smoke.mjs
import fs from 'node:fs';
import { CHANNELS, channelFor } from '../functions/_shared/channels.js';
import { onRequest as chatFn } from '../functions/v1/chat/completions/index.js';
import { onRequest as responsesFn } from '../functions/v1/responses/index.js';

const secrets = JSON.parse(fs.readFileSync(new URL('../secrets.local.json', import.meta.url), 'utf8'));
const KEY_ENV = {
  4: 'EO_KEY_VOLCENGINE_ARK',
  5: 'EO_KEY_AGNES',
  11: 'EO_KEY_ZHIPU',
  13: 'EO_KEY_ZEN',
  14: 'EO_KEY_SAIL',
  15: 'EO_KEY_OPENROUTER',
  16: 'EO_KEY_UNISOUND',
};
const env = { EO_PROXY_KEY: secrets.proxy_api_key };
for (const ch of secrets.channels) if (KEY_ENV[ch.id]) env[KEY_ENV[ch.id]] = ch.key || '';

let drift = 0;
for (const ch of secrets.channels) {
  const code = CHANNELS.find((c) => c.id === ch.id);
  if (!code) { console.log('DRIFT  渠道 ' + ch.id + ' 在代码里不存在'); drift++; continue; }
  if (code.urls[0] !== ch.chat_url) { console.log('DRIFT  ' + ch.name + ' 代码URL=' + code.urls[0] + ' secretsURL=' + ch.chat_url); drift++; }
  const missing = code.models.filter((m) => !ch.models.includes(m));
  if (missing.length) { console.log('DRIFT  ' + ch.name + ' 代码多出模型: ' + missing.join(',')); drift++; }
}
console.log('drift=' + drift);

const base = 'https://agg.edgeonepage.com';
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout ' + ms + 'ms')), ms))]);
const call = (fn, path, init) => withTimeout(fn({ request: new Request(base + path, init), env, params: {} }), 60000);
const post = (model, extra = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.EO_PROXY_KEY },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 32, ...extra }),
});

const postResp = (model, extra = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.EO_PROXY_KEY },
  body: JSON.stringify({ model, input: '只回复两个字：收到', max_output_tokens: 64, ...extra }),
});

const chatModels = ['space-bunny-free', 'agnes-2.5-flash', 'kimi-k2.7-code', 'u2-flash'];
for (const m of chatModels) {
  try {
    const res = await call(chatFn, '/v1/chat/completions', post(m));
    const body = await res.text();
    let snippet = body.slice(0, 90).replace(/\s+/g, ' ');
    try { const j = JSON.parse(body); snippet = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || (j.error && j.error.message) || snippet; } catch (e) {}
    console.log('chat  ' + m + '  status=' + res.status + '  ' + String(snippet).slice(0, 80));
  } catch (e) {
    console.log('chat  ' + m + '  ERROR ' + e.message);
  }
}

let streamOk = 0;
for (const m of ['space-bunny-free', 'agnes-2.5-flash']) {
  try {
    const res = await call(responsesFn, '/v1/responses', postResp(m, { stream: true }));
    if (!res.ok) { console.log('resp  ' + m + '  HTTP ' + res.status + '  ' + (await res.text()).slice(0, 120)); continue; }
    const raw = await res.text();
    const events = raw.split('\n\n').filter((b) => b.trim()).map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data:')).slice(5).trim()));
    const types = events.map((e) => e.type);
    const seqOk = events.every((e, i) => e.sequence_number === i + 1);
    const text = events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
    const okSeq = types[0] === 'response.created' && types[1] === 'response.in_progress' && types[types.length - 1] === 'response.completed';
    const parts = ['created/in_progress/completed', seqOk, types.includes('response.content_part.added'), types.includes('response.output_text.done'), text.length > 0];
    console.log('resp  ' + m + '  events=' + events.length + '  text=' + JSON.stringify(text.slice(0, 40)) + '  checks=' + parts.join(','));
    if (okSeq && seqOk && text.length > 0) streamOk++;
  } catch (e) {
    console.log('resp  ' + m + '  ERROR ' + e.message);
  }
}

console.log('\nstreamOk=' + streamOk + '/2');
process.exit(streamOk === 2 ? 0 : 1);
