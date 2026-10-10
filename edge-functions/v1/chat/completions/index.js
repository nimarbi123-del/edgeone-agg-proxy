import {
  channelFor,
  clientAuth,
  allModels,
  apiError,
  preflight,
  postUpstream,
  upstreamToClient,
  CORS,
} from '../../../_shared/channels.js';

// POST /v1/chat/completions —— 按 model 路由到对应上游渠道，注入密钥后透传（含 SSE 流式）
export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();

  const a = clientAuth(request, env);
  if (!a.ok) return apiError('unauthorized: 请带 Authorization: Bearer <EO_PROXY_KEY>', 401, 'authentication_error');

  const url = new URL(request.url);
  if (request.method === 'GET') {
    return new Response(JSON.stringify({ object: 'list', data: allModels() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    });
  }
  if (request.method !== 'POST') return apiError('method not allowed', 405);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return apiError('请求体不是合法 JSON', 400);
  }

  const model = body && body.model;
  const channel = channelFor(model);
  if (!channel) {
    return apiError('未知模型: ' + String(model) + '；可用模型: ' + allModels().map((m) => m.id).join(', '), 404);
  }


  const payload = { ...body };
  delete payload.model_alias;
  if (url.searchParams.get('stream') === 'true') payload.stream = true;

  let result;
  try {
    result = await postUpstream(channel, env, payload);
  } catch (e) {
    return apiError('上游请求失败: ' + e.message, 502, 'upstream_error');
  }
  const res = result.response;
  if (!res) return apiError('上游无响应', 502, 'upstream_error');
  return upstreamToClient(res, a.warn);
}
