import {
  channelFor,
  clientAuth,
  allModels,
  apiError,
  preflight,
  postUpstream,
  CORS,
} from '../../_shared/channels.js';

// POST /v1/responses —— Codex CLI 用的 Responses API。
// 请求转成 Chat Completions，回包按 Responses 的严格 SSE 事件序列还原。

const enc = new TextEncoder();
const rid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'input_image') return '[image]';
      if (p.type === 'refusal') return p.refusal || '';
      return p.text || '';
    })
    .join('');
}

export function toChatMessages(body) {
  const msgs = [];
  if (body.instructions) msgs.push({ role: 'system', content: String(body.instructions) });
  const input = body.input;
  if (typeof input === 'string') {
    msgs.push({ role: 'user', content: input });
    return msgs;
  }
  if (!Array.isArray(input)) return msgs;
  for (const item of input) {
    if (typeof item === 'string') {
      msgs.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') {
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id || rid('call'),
            type: 'function',
            function: { name: item.name || '', arguments: item.arguments || '' },
          },
        ],
      });
    } else if (item.type === 'function_call_output') {
      msgs.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output == null ? '' : item.output),
      });
    } else if (item.type === 'reasoning') {
      continue;
    } else {
      msgs.push({ role: item.role || 'user', content: contentToText(item.content) });
    }
  }
  return msgs;
}

export function toChatTools(body) {
  const list = Array.isArray(body.tools) ? body.tools : [];
  const tools = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const f = t.function && t.function.name ? t.function : t.type === 'function' && t.name ? t : null;
    if (!f) continue;
    tools.push({
      type: 'function',
      function: {
        name: f.name,
        description: f.description || '',
        parameters: f.parameters || { type: 'object', properties: {} },
      },
    });
  }
  return tools;
}

function toChatToolChoice(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  const name = tc.name || (tc.function && tc.function.name);
  if (name) return { type: 'function', function: { name } };
  return undefined;
}

function skeleton(id, model) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model,
    output: [],
    output_text: '',
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    temperature: null,
    top_p: null,
    truncation: 'disabled',
    metadata: {},
  };
}

function buildResponse(id, model, chatJson) {
  const choice = (chatJson.choices && chatJson.choices[0]) || {};
  const msg = choice.message || {};
  const output = [];
  for (const c of msg.tool_calls || []) {
    output.push({
      id: rid('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: c.id || rid('call'),
      name: (c.function && c.function.name) || '',
      arguments: (c.function && c.function.arguments) || '',
    });
  }
  const text = typeof msg.content === 'string' ? msg.content : contentToText(msg.content);
  if (text) {
    output.push({
      id: rid('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  const u = chatJson.usage || {};
  const r = skeleton(id, model);
  r.status = 'completed';
  r.output = output;
  r.output_text = text;
  r.usage = {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || 0,
  };
  return r;
}

export function convertStream(upstream, model) {
  const id = rid('resp');
  return new ReadableStream({
    async start(controller) {
      let seq = 0;
      const send = (obj) => {
        obj.sequence_number = ++seq;
        controller.enqueue(enc.encode('event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n'));
      };
      send({ type: 'response.created', response: skeleton(id, model) });
      send({ type: 'response.in_progress', response: skeleton(id, model) });

      let outCount = 0;
      let msgItemId = null;
      let msgIndex = null;
      let text = '';
      const calls = new Map();
      let failed = null;

      const openMessage = () => {
        if (msgIndex !== null) return;
        msgIndex = outCount++;
        msgItemId = rid('msg');
        send({
          type: 'response.output_item.added',
          output_index: msgIndex,
          item: { id: msgItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        });
        send({
          type: 'response.content_part.added',
          item_id: msgItemId,
          output_index: msgIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
      };

      const onText = (d) => {
        if (!d) return;
        openMessage();
        text += d;
        send({
          type: 'response.output_text.delta',
          item_id: msgItemId,
          output_index: msgIndex,
          content_index: 0,
          delta: d,
        });
      };

      const openCall = (idx, callId, name) => {
        const outIndex = outCount++;
        const itemId = rid('fc');
        const call = { itemId, outIndex, callId: callId || rid('call'), name: name || '', args: '' };
        calls.set(idx, call);
        send({
          type: 'response.output_item.added',
          output_index: outIndex,
          item: {
            id: itemId,
            type: 'function_call',
            status: 'in_progress',
            call_id: call.callId,
            name: call.name,
            arguments: '',
          },
        });
        return call;
      };

      const onToolCall = (tc) => {
        const idx = tc.index || 0;
        const fn = tc.function || {};
        let call = calls.get(idx);
        if (!call) call = openCall(idx, tc.id, fn.name);
        else if (fn.name && !call.name) call.name = fn.name;
        const d = fn.arguments || '';
        if (d) {
          call.args += d;
          send({
            type: 'response.function_call_arguments.delta',
            item_id: call.itemId,
            output_index: call.outIndex,
            delta: d,
          });
        }
      };

      const onChunk = (json) => {
        if (json.error) {
          failed = json.error;
          return;
        }
        const ch = (json.choices && json.choices[0]) || {};
        const d = ch.delta || {};
        if (typeof d.content === 'string') onText(d.content);
        if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) onToolCall(tc);
      };

      const reader = upstream.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              onChunk(JSON.parse(data));
            } catch (e) {
              /* 非 JSON 行直接忽略 */
            }
            if (failed) break;
          }
          if (failed) break;
        }
      } catch (e) {
        failed = { message: '上游流读取失败: ' + e.message, type: 'upstream_error' };
      }

      const output = [];
      if (msgIndex !== null) {
        send({ type: 'response.output_text.done', item_id: msgItemId, output_index: msgIndex, content_index: 0, text });
        send({
          type: 'response.content_part.done',
          item_id: msgItemId,
          output_index: msgIndex,
          content_index: 0,
          part: { type: 'output_text', text, annotations: [] },
        });
        const item = {
          id: msgItemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        };
        send({ type: 'response.output_item.done', output_index: msgIndex, item });
        output[msgIndex] = item;
      }
      for (const call of Array.from(calls.values()).sort((a, b) => a.outIndex - b.outIndex)) {
        send({
          type: 'response.function_call_arguments.done',
          item_id: call.itemId,
          output_index: call.outIndex,
          arguments: call.args,
        });
        const item = {
          id: call.itemId,
          type: 'function_call',
          status: 'completed',
          call_id: call.callId,
          name: call.name,
          arguments: call.args,
        };
        send({ type: 'response.output_item.done', output_index: call.outIndex, item });
        output[call.outIndex] = item;
      }

      const final = skeleton(id, model);
      final.output = output.filter(Boolean);
      final.output_text = text;
      if (failed) {
        final.status = 'failed';
        final.error = {
          code: failed.code || 'upstream_error',
          message: failed.message || 'upstream error',
          type: failed.type || 'upstream_error',
        };
        send({ type: 'response.failed', response: final });
      } else {
        final.status = 'completed';
        final.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
        send({ type: 'response.completed', response: final });
      }
      controller.close();
    },
  });
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return preflight();

  const a = clientAuth(request, env);
  if (!a.ok) return apiError('unauthorized: 请带 Authorization: Bearer <EO_PROXY_KEY>', 401, 'authentication_error');
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

  const wantStream = body.stream !== false;
  const chatBody = { model, messages: toChatMessages(body), stream: wantStream };
  if (!chatBody.messages.length) return apiError('input 为空', 400);
  if (body.temperature != null) chatBody.temperature = body.temperature;
  if (body.top_p != null) chatBody.top_p = body.top_p;
  const maxTokens = body.max_output_tokens || body.max_tokens;
  if (maxTokens) chatBody.max_tokens = maxTokens;
  const tools = toChatTools(body);
  if (tools.length) {
    chatBody.tools = tools;
    const tc = toChatToolChoice(body.tool_choice);
    if (tc) chatBody.tool_choice = tc;
  }

  let result;
  try {
    result = await postUpstream(channel, env, chatBody);
  } catch (e) {
    return apiError('上游请求失败: ' + e.message, 502, 'upstream_error');
  }
  const res = result.response;
  if (!res) return apiError('上游无响应', 502, 'upstream_error');

  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !ct.includes('event-stream')) {
    let payload = null;
    try {
      payload = await res.json();
    } catch (e) {
      payload = null;
    }
    if (!res.ok) {
      const err = (payload && payload.error) || { message: '上游返回 ' + res.status, type: 'upstream_error' };
      return new Response(JSON.stringify({ error: err }), {
        status: res.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
      });
    }
    const r = buildResponse(rid('resp'), model, payload || {});
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    });
  }

  const headers = {
    ...CORS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  };
  if (a.warn) headers['X-Proxy-Warning'] = encodeURIComponent(a.warn);
  return new Response(convertStream(res.body, model), { status: 200, headers });
}
