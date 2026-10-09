import { allModels, clientAuth, CORS } from '../../_shared/channels.js';

// GET /v1/models —— 返回本代理聚合的全部模型
export async function onRequest({ request, env }) {
  const a = clientAuth(request, env);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...CORS };
  if (!a.ok) {
    return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401, headers });
  }
  if (a.warn) headers['X-Proxy-Warning'] = encodeURIComponent(a.warn);
  return new Response(JSON.stringify({ object: 'list', data: allModels() }), { status: 200, headers });
}
