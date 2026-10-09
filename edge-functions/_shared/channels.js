// 渠道表（不含密钥）。密钥只放 EdgeOne Pages 环境变量，通过 keyEnv 读取。
// 改模型/上游地址改这里；改密钥只改环境变量，不必重新部署代码。

export const CHANNELS = [
  {
    id: 4,
    name: 'VolcengineArk',
    keyEnv: 'EO_KEY_VOLCENGINE_ARK',
    auth: 'bearer',
    urls: [
      'https://ark.cn-beijing.volces.com/api/plan/v1/chat/completions',
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    ],
    models: ['kimi-k2.7-code', 'doubao-seed-2.1-turbo', 'glm-5.2', 'kimi-k3', 'glm-5.3'],
  },
  {
    id: 5,
    name: 'AgnesAI',
    keyEnv: 'EO_KEY_AGNES',
    auth: 'bearer',
    urls: ['https://api.agnes-ai.cn/v1/chat/completions'],
    models: ['agnes-2.5-flash', 'agnes-3.0-flash'],
  },
  {
    id: 11,
    name: 'glm53-flash-zhipu',
    keyEnv: 'EO_KEY_ZHIPU',
    auth: 'bearer',
    urls: ['https://open.bigmodel.cn/api/paas/v4/chat/completions'],
    models: ['glm-5.3-flash'],
  },
  {
    id: 13,
    name: 'opencode-zen',
    keyEnv: 'EO_KEY_ZEN',
    auth: 'none',
    urls: ['https://opencode.ai/zen/v1/chat/completions'],
    models: ['space-bunny-free'],
  },
  {
    id: 14,
    name: 'ShanghaiAILab',
    keyEnv: 'EO_KEY_SAIL',
    auth: 'bearer',
    urls: ['https://discovery-api.intern-ai.org.cn/v1/chat/completions'],
    models: ['qwen3.8-27b', 'deepseek-v4-flash-vision', 'glm-5.3'],
  },
  {
    id: 15,
    name: 'OpenRouter-Ling31Flash',
    keyEnv: 'EO_KEY_OPENROUTER',
    auth: 'bearer',
    urls: ['https://openrouter.ai/api/v1/chat/completions'],
    models: ['inclusionai/ling-3.1-flash'],
  },
  {
    id: 16,
    name: 'UnisoundU2Flash',
    keyEnv: 'EO_KEY_UNISOUND',
    auth: 'bearer',
    urls: ['https://maas-api.unisound.com/v1/chat/completions'],
    models: ['u2-flash'],
  },
];

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Key',
  'Access-Control-Max-Age': '86400',
};

export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

export function apiError(message, status = 400, type = 'invalid_request_error') {
  return json({ error: { message, type, code: null, param: null } }, status);
}

export function channelFor(model) {
  if (!model) return null;
  for (const c of CHANNELS) if (c.models.includes(model)) return c;
  return null;
}

export function allModels() {
  const seen = new Set();
  const out = [];
  for (const c of CHANNELS) {
    for (const m of c.models) {
      if (seen.has(m)) continue;
      seen.add(m);
      out.push({ id: m, object: 'model', owned_by: c.name, created: 1757000000 });
    }
  }
  return out;
}

// 客户端鉴权：Authorization: Bearer <EO_PROXY_KEY> 或 X-Proxy-Key。
// EO_PROXY_KEY 未设置时放行并回带告警头（便于先跑通，再收紧）。
export function clientAuth(request, env) {
  const expected = String(env.EO_PROXY_KEY || '').trim();
  const authz = String(request.headers.get('authorization') || '');
  const provided =
    authz.replace(/^Bearer\s+/i, '').trim() || String(request.headers.get('x-proxy-key') || '').trim();
  if (!expected) return { ok: true, warn: 'EO_PROXY_KEY 未设置，任何人可调用本代理' };
  if (provided && provided === expected) return { ok: true, warn: '' };
  return { ok: false, warn: '' };
}

// 依次尝试渠道 urls（第二个是路径兜底），只在 404/405 时换下一个。
export async function postUpstream(channel, env, payload) {
  const key = String(env[channel.keyEnv] || '').trim();
  if (channel.auth !== 'none' && !key) {
    return { response: apiError('环境变量 ' + channel.keyEnv + ' 未配置', 500, 'server_error'), channel };
  }
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (channel.auth === 'bearer') headers.Authorization = 'Bearer ' + key;
  if (channel.id === 15) {
    headers['HTTP-Referer'] = 'https://edgeonepage.com';
    headers['X-Title'] = 'edgeone-agg-proxy';
  }
  const body = JSON.stringify(payload);
  let last = null;
  for (const url of channel.urls) {
    const res = await fetch(url, { method: 'POST', headers, body });
    if (res.status === 404 || res.status === 405) {
      last = res;
      try { await res.text(); } catch (e) { /* ignore */ }
      continue;
    }
    return { response: res, channel, url };
  }
  return { response: last, channel };
}

export function upstreamToClient(res, warn) {
  const ct = res.headers.get('content-type') || 'application/json';
  const headers = { ...CORS, 'Content-Type': ct, 'Cache-Control': 'no-cache' };
  if (ct.includes('event-stream')) headers['X-Accel-Buffering'] = 'no';
  if (warn) headers['X-Proxy-Warning'] = encodeURIComponent(warn);
  return new Response(res.body, { status: res.status, headers });
}
