// 渠道表（不含密钥）。密钥只放 EdgeOne Pages 环境变量，通过 keyEnv 读取。
// 改模型/上游地址改这里；改密钥只改环境变量，不必重新部署代码。

// ---------- Anthropic Messages 协议适配（claude-haiku-5-5 等只认这个协议） ----------
function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
}

export function chatToAnthropic(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const systemParts = [];
  const out = [];
  for (const m of msgs) {
    if (!m || !m.role) continue;
    if (m.role === 'system' || m.role === 'developer') {
      const t = blocksToText(m.content);
      if (t) systemParts.push(t);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id || '', content: blocksToText(m.content) }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const text = blocksToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id || 'toolu_' + Math.random().toString(36).slice(2, 10), name: (tc.function && tc.function.name) || '', input });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    const blocks = [];
    if (Array.isArray(m.content)) {
      for (const part of m.content) if (part && part.type === 'text') blocks.push({ type: 'text', text: part.text || '' });
    } else {
      const t = blocksToText(m.content);
      if (t) blocks.push({ type: 'text', text: t });
    }
    if (!blocks.length) blocks.push({ type: 'text', text: '' });
    out.push({ role: 'user', content: blocks });
  }

  const req = {
    model: body.model,
    max_tokens: Number(body.max_tokens || body.max_output_tokens) || 4096,
    messages: out,
  };
  if (systemParts.length) req.system = systemParts.join('\n\n');
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (body.stream) req.stream = true;

  const tools = (Array.isArray(body.tools) ? body.tools : []).filter((t) => t && t.type === 'function' && t.function && t.function.name);
  if (tools.length && body.tool_choice !== 'none') {
    req.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
    const tc = body.tool_choice;
    if (tc === 'required') req.tool_choice = { type: 'any' };
    else if (tc === 'auto') req.tool_choice = { type: 'auto' };
    else if (tc && tc.type === 'function' && tc.function && tc.function.name) req.tool_choice = { type: 'tool', name: tc.function.name };
  }
  return req;
}

export function anthropicJsonToChat(j, model) {
  const text = [];
  const toolCalls = [];
  for (const b of (j && j.content) || []) {
    if (!b) continue;
    if (b.type === 'text') text.push(b.text || '');
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id || 'call_' + Math.random().toString(36).slice(2, 10),
        type: 'function',
        function: { name: b.name || '', arguments: JSON.stringify(b.input || {}) },
      });
    }
  }
  const msg = { role: 'assistant', content: text.join('') };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  const sr = (j && j.stop_reason) || '';
  const finish = sr === 'tool_use' ? 'tool_calls' : sr === 'max_tokens' ? 'length' : 'stop';
  const u = (j && j.usage) || {};
  return {
    id: (j && j.id) || 'chatcmpl-' + Date.now().toString(36),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: {
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    },
  };
}

// Anthropic SSE -> Anthropic JSON（给非流式客户端用）
export async function anthropicSseToJson(upstream) {
  const reader = upstream.getReader();
  const dec = new TextDecoder();
  const blocks = [];
  const byIndex = new Map();
  let buf = '';
  let id = 'msg_' + Date.now().toString(36);
  let stopReason = null;
  let usage = {};
  const ensure = (idx, init) => {
    if (!byIndex.has(idx)) { byIndex.set(idx, init); blocks.push(init); }
    return byIndex.get(idx);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(raw); } catch (e) { continue; }
      if (ev.type === 'message_start') {
        if (ev.message && ev.message.id) id = ev.message.id;
        if (ev.message && ev.message.usage) usage = { ...usage, ...ev.message.usage };
      } else if (ev.type === 'content_block_start') {
        const cb = ev.content_block || {};
        if (cb.type === 'tool_use') ensure(ev.index, { type: 'tool_use', id: cb.id, name: cb.name, input: {}, _json: '' });
        else ensure(ev.index, { type: 'text', text: '' });
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        const blk = ensure(ev.index, { type: 'text', text: '' });
        if (d.type === 'text_delta') blk.text = (blk.text || '') + (d.text || '');
        else if (d.type === 'input_json_delta') blk._json = (blk._json || '') + (d.partial_json || '');
      } else if (ev.type === 'message_delta') {
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage) usage = { ...usage, ...ev.usage };
      }
    }
  }
  for (const b of blocks) {
    if (b.type === 'tool_use') {
      try { b.input = JSON.parse(b._json || '{}'); } catch (e) { b.input = {}; }
      delete b._json;
    }
  }
  return { id, type: 'message', role: 'assistant', content: blocks, stop_reason: stopReason, usage };
}

// Anthropic SSE -> OpenAI chat.completion.chunk SSE
export function anthropicSseToChatSse(upstream, model) {
  const encoder = new TextEncoder();
  const id = 'chatcmpl-' + Date.now().toString(36);
  return new ReadableStream({
    async start(controller) {
      const send = (delta, finish) => {
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason: finish || null }],
        };
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
      };
      let started = false;
      let toolIndex = -1;
      let stopReason = null;
      const reader = upstream.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let ev;
            try { ev = JSON.parse(raw); } catch (e) { continue; }
            if (ev.type === 'message_start') {
              if (!started) { send({ role: 'assistant', content: '' }); started = true; }
              continue;
            }
            if (ev.type === 'content_block_start') {
              if (!started) { send({ role: 'assistant', content: '' }); started = true; }
              const cb = ev.content_block || {};
              if (cb.type === 'tool_use') {
                toolIndex += 1;
                send({ tool_calls: [{ index: toolIndex, id: cb.id || 'call_' + toolIndex, type: 'function', function: { name: cb.name || '', arguments: '' } }] });
              }
              continue;
            }
            if (ev.type === 'content_block_delta') {
              const d = ev.delta || {};
              if (d.type === 'text_delta' && d.text) send({ content: d.text });
              else if (d.type === 'input_json_delta' && d.partial_json) send({ tool_calls: [{ index: toolIndex < 0 ? 0 : toolIndex, function: { arguments: d.partial_json } }] });
              continue;
            }
            if (ev.type === 'message_delta') {
              if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
              continue;
            }
          }
        }
        const finish = stopReason === 'tool_use' ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : 'stop';
        send({}, finish);
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (e) {
        try { controller.error(e); } catch (e2) { /* already closed */ }
      }
    },
  });
}

// ---------- Responses 协议适配（gpt-6-luna / grok / muse-spark 等只认 Responses 协议） ----------
// 把 OpenAI Chat 请求转成 Responses 格式，发往上流；把 Responses 响应/流转回 Chat 格式给客户端。

function chatMsgToText(msg) {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'input_image') return '[image]';
      return p.text || '';
    })
    .join('');
}

export function chatToResponses(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const input = [];
  let instructions = '';
  for (const m of msgs) {
    if (!m || !m.role) continue;
    if (m.role === 'system') {
      const t = chatMsgToText(m);
      if (t) instructions = instructions ? instructions + '\n\n' + t : t;
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || '',
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
      });
      continue;
    }
    if (m.role === 'assistant') {
      const text = chatMsgToText(m);
      for (const tc of m.tool_calls || []) {
        input.push({
          type: 'function_call',
          call_id: tc.id || 'call_' + Math.random().toString(36).slice(2, 10),
          name: (tc.function && tc.function.name) || '',
          arguments: (tc.function && tc.function.arguments) || '',
        });
      }
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
      continue;
    }
    const t = chatMsgToText(m);
    if (t) input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] });
  }
  const req = { model: body.model, input };
  if (instructions) req.instructions = instructions;
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (body.stream) req.stream = true;
  const maxTok = body.max_tokens || body.max_output_tokens;
  if (maxTok) req.max_output_tokens = maxTok;
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter(
    (t) => t && t.type === 'function' && t.function && t.function.name,
  );
  if (tools.length && body.tool_choice !== 'none') {
    req.tools = tools.map((t) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters || { type: 'object', properties: {} },
    }));
    const tc = body.tool_choice;
    if (tc === 'required') req.tool_choice = 'required';
    else if (tc === 'auto') req.tool_choice = 'auto';
    else if (tc && tc.type === 'function' && tc.function && tc.function.name) req.tool_choice = { type: 'function', name: tc.function.name };
  }
  return req;
}

// 非流式：Responses 对象 -> chat.completion
export function responsesJsonToChat(j, model) {
  const out = (j && j.output) || [];
  let text = '';
  const toolCalls = [];
  for (const item of out) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && item.role === 'assistant') {
      const c = item.content || [];
      for (const p of c) if (p && p.type === 'output_text' && p.text) text += p.text;
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id || 'call_' + Math.random().toString(36).slice(2, 10),
        type: 'function',
        function: { name: item.name || '', arguments: item.arguments || '' },
      });
    }
  }
  const msg = { role: 'assistant', content: text };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  const u = (j && j.usage) || {};
  const finish = j && j.status === 'incomplete' ? 'length' : 'stop';
  return {
    id: (j && j.id) || 'chatcmpl-' + Date.now().toString(36),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msg, finish_reason: finish, logprobs: null }],
    usage: {
      prompt_tokens: u.input_tokens || 0,
      completion_tokens: u.output_tokens || 0,
      total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
    },
  };
}

// 流式：Responses SSE -> OpenAI chat.completion.chunk SSE
export function responsesSseToChatSse(upstream, model) {
  const encoder = new TextEncoder();
  const id = 'chatcmpl-' + Date.now().toString(36);
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const send = (delta, finish) => {
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason: finish || null, logprobs: null }],
        };
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
      };
      try {
        send({ role: 'assistant', content: '' });
        const toolCallsOut = [];
        let hasText = false;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = raw.split('\n');
            let eventType = '';
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) eventType = line.slice(7).trim();
              else if (line.startsWith('data: ')) dataStr += line.slice(6);
            }
            if (!dataStr) continue;
            let ev;
            try { ev = JSON.parse(dataStr); } catch (e) { continue; }
            if (eventType === 'response.output_text.delta' && ev && typeof ev.delta === 'string') {
              send({ content: ev.delta });
              hasText = true;
            } else if (eventType === 'response.function_call_arguments.delta' && ev) {
              const itemId = ev.item_id || '';
              let tcIdx = toolCallsOut.findIndex((t) => t.itemId === itemId);
              if (tcIdx < 0) {
                tcIdx = toolCallsOut.length;
                toolCallsOut.push({ index: tcIdx, id: itemId, name: ev.name || '', args: '', itemId });
              }
              const tc = toolCallsOut[tcIdx];
              if (ev.name && !tc.name) tc.name = ev.name;
              tc.args += ev.delta || '';
              const delta = {
                tool_calls: [{
                  index: tc.index,
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: ev.delta || '' },
                }],
              };
              if (toolCallsOut.length === 1 && !hasText) delta.role = 'assistant';
              send(delta);
            }
          }
        }
        send({}, 'stop');
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (e) {
        try { controller.error(e); } catch (e2) { /* already closed */ }
      }
    },
  });
}

// Responses SSE -> Responses JSON（给非流式客户端用）
async function responsesSseToJson(upstream) {
  const reader = upstream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let finalObj = null;
  let outputText = '';
  const output = [];
  const byId = new Map();
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let status = 'completed';
  let id = 'resp_' + Date.now().toString(36);
  let model = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = raw.split('\n');
      let eventType = '';
      let dataStr = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) eventType = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataStr += line.slice(6);
      }
      if (!dataStr) continue;
      let ev;
      try { ev = JSON.parse(dataStr); } catch (e) { continue; }
      if (eventType === 'response.created' || eventType === 'response.in_progress') {
        const r = ev.response || ev;
        if (r.id) id = r.id;
        if (r.model) model = r.model;
      } else if (eventType === 'response.output_text.delta' && typeof ev.delta === 'string') {
        outputText += ev.delta;
      } else if (eventType === 'response.output_item.added' && ev.item) {
        const item = ev.item;
        if (item.id) byId.set(item.id, item);
        output.push(item);
      } else if (eventType === 'response.content_part.added' && ev.item_id && ev.part) {
        const item = byId.get(ev.item_id);
        if (item && Array.isArray(item.content)) item.content.push(ev.part);
      } else if (eventType === 'response.output_text.done') {
        // 文本结束
      } else if (eventType === 'response.completed') {
        const r = ev.response || ev;
        status = r.status || 'completed';
        if (r.usage) usage = r.usage;
        if (r.id) id = r.id;
        if (r.model) model = r.model;
        if (r.output && r.output.length) {
          // 用完整 output 覆盖
          for (let i = 0; i < r.output.length; i++) {
            if (i < output.length) output[i] = r.output[i];
            else output.push(r.output[i]);
          }
        }
      } else if (eventType === 'response.failed') {
        const r = ev.response || ev;
        status = 'failed';
        if (r.id) id = r.id;
      }
    }
  }
  return { id, model, object: 'response', status, output, output_text: outputText, usage };
}

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
    id: 16,
    name: 'UnisoundU2Flash',
    hedge: 2,
    keyEnv: 'EO_KEY_UNISOUND',
    auth: 'bearer',
    urls: ['https://maas-api.unisound.com/v1/chat/completions'],
    models: ['u2-flash'],
  },
  {
    id: 17,
    name: 'opencode-go',
    keyEnv: 'EO_KEY_OPENCODE_GO',
    auth: 'bearer',
    sessionHeader: 'x-opencode-session',
    protocol: 'chat',
    urls: ['https://opencode.ai/zen/go/v1/chat/completions'],
    models: ['minimax-m3', 'minimax-m2.5', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'longcat-2.0', 'glm-5.2', 'glm-5.3-flash', 'glm-5.3', 'glm-5.1', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash-vision-exp', 'qwen3.7-max', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3.6-plus', 'mimo-v2.6-pro', 'mimo-v2.6-flash', 'longcat-2.5-preview-free', 'step-5-preview-free', 'mimo-v2.5-pro', 'mimo-v2.5', 'hy4-preview', 'hy3', 'omen-alpha', 'space-bunny'],
  },
  {
    id: 18,
    name: 'opencode-go-resp',
    keyEnv: 'EO_KEY_OPENCODE_GO',
    auth: 'bearer',
    sessionHeader: 'x-opencode-session',
    protocol: 'responses',
    urls: ['https://opencode.ai/zen/go/v1/responses'],
    models: ['gpt-6-luna', 'gpt-5.6-luna', 'grok-4.6', 'grok-4.7', 'muse-spark-1.2-contributor', 'muse-spark-1.3-contributor', 'deepseek-flash'],
  },
  {
    id: 19,
    name: 'opencode-go-msg',
    keyEnv: 'EO_KEY_OPENCODE_GO',
    auth: 'anthropic',
    sessionHeader: 'x-opencode-session',
    anthropicVersion: '2023-06-01',
    protocol: 'anthropic',
    urls: ['https://opencode.ai/zen/go/v1/messages'],
    models: ['claude-haiku-5-5'],
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

// 对冲请求：同一渠道并发 n 路，取第一个成功返回的（尾延迟治理）。
// 只对显式标了 hedge 的渠道启用，默认 1 路（不开）。
function hedgeFetch(url, opts, n) {
  if (!n || n < 2) return fetch(url, opts);
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(fetch(url, opts));
  return new Promise((resolve, reject) => {
    let pending = ps.length;
    let fallback = null;
    let finished = false;
    const done = (r) => {
      if (finished) {
        try { if (r && r.body) r.body.cancel(); } catch (e) { /* ignore */ }
        return;
      }
      finished = true;
      resolve(r);
    };
    ps.forEach((p) => {
      p.then((r) => {
        if (r.ok) { done(r); return; }
        if (!fallback) fallback = r;
        pending -= 1;
        if (pending === 0) done(fallback);
      }).catch(() => {
        pending -= 1;
        if (pending === 0) {
          if (fallback) done(fallback);
          else reject(new Error('hedge: all attempts failed'));
        }
      });
    });
  });
}

// 依次尝试渠道 urls（第二个是路径兜底），只在 404/405 时换下一个。
// protocol='anthropic' 的渠道：请求/响应在网关内翻译成 OpenAI Chat 格式，
// 这样 /v1/chat/completions 和 /v1/responses 都能直接调用它。
export async function postUpstream(channel, env, payload) {
  const key = String(env[channel.keyEnv] || '').trim();
  if (channel.auth !== 'none' && !key) {
    return { response: apiError('环境变量 ' + channel.keyEnv + ' 未配置', 500, 'server_error'), channel };
  }
  const isAnthropic = channel.protocol === 'anthropic';
  const isResponsesProto = channel.protocol === 'responses';
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (channel.auth === 'bearer') headers.Authorization = 'Bearer ' + key;
  if (channel.auth === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = channel.anthropicVersion || '2023-06-01';
  }
  if (channel.sessionHeader) {
    headers[channel.sessionHeader] =
      globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : 'oc-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
  const wantStream = payload && payload.stream === true;
  let upstreamBody = payload;
  if (isAnthropic) upstreamBody = chatToAnthropic(payload);
  else if (isResponsesProto) upstreamBody = chatToResponses(payload);
  const body = JSON.stringify(upstreamBody);
  let last = null;
  for (const url of channel.urls) {
    const opts = { method: 'POST', headers, body };
    let res;
    try {
      res = await hedgeFetch(url, opts, channel.hedge || 1);
    } catch (e) {
      // 跨境链路偶发网络抖动：同渠道再试一次
      try {
        res = await hedgeFetch(url, opts, channel.hedge || 1);
      } catch (e2) {
        return { response: apiError('上游网络错误: ' + e2.message, 502, 'upstream_error'), channel };
      }
    }
    if (res.status === 404 || res.status === 405) {
      last = res;
      try { await res.text(); } catch (e) { /* ignore */ }
      continue;
    }
    if (isAnthropic) {
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('event-stream')) {
        let j = null;
        try { j = await res.json(); } catch (e) { j = null; }
        if (!res.ok) {
          return { response: new Response(JSON.stringify(j || { error: { message: '上游返回 ' + res.status } }), { status: res.status, headers: { 'Content-Type': 'application/json' } }), channel, url };
        }
        return { response: new Response(JSON.stringify(anthropicJsonToChat(j || {}, payload.model)), { status: 200, headers: { 'Content-Type': 'application/json' } }), channel, url };
      }
      if (!wantStream) {
        // 客户端要非流式：把 Anthropic SSE 收完再拼成一个 chat.completion
        const j = await anthropicSseToJson(res.body);
        return { response: new Response(JSON.stringify(anthropicJsonToChat(j, payload.model)), { status: 200, headers: { 'Content-Type': 'application/json' } }), channel, url };
      }
      return { response: new Response(anthropicSseToChatSse(res.body, payload.model), { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }), channel, url };
    }
    if (isResponsesProto) {
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('event-stream')) {
        let j = null;
        try { j = await res.json(); } catch (e) { j = null; }
        if (!res.ok) {
          const err = (j && j.error) || { message: '上游返回 ' + res.status, type: 'upstream_error' };
          return { response: new Response(JSON.stringify({ error: err }), { status: res.status, headers: { 'Content-Type': 'application/json' } }), channel, url };
        }
        return { response: new Response(JSON.stringify(responsesJsonToChat(j || {}, payload.model)), { status: 200, headers: { 'Content-Type': 'application/json' } }), channel, url };
      }
      if (!wantStream) {
        // 客户端要非流式：把 Responses SSE 收完再拼成一个 chat.completion
        const j = await responsesSseToJson(res.body);
        return { response: new Response(JSON.stringify(responsesJsonToChat(j, payload.model)), { status: 200, headers: { 'Content-Type': 'application/json' } }), channel, url };
      }
      return { response: new Response(responsesSseToChatSse(res.body, payload.model), { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }), channel, url };
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
