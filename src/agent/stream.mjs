export function sseWriter(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  return {
    send(event, data = {}) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      try { res.end(); } catch { /* closed */ }
    },
  };
}

export async function consumeSse(response, onJson) {
  const type = contentType(response);
  if (response.body && typeof response.body.getReader === 'function' && (type.includes('text/event-stream') || type.includes('json'))) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() || '';
      for (const part of parts) dispatchSseBlock(part, onJson);
    }
    if (buffer.trim()) dispatchSseBlock(buffer, onJson);
    return;
  }
  const text = await response.text();
  if (looksLikeSse(text)) {
    for (const block of text.split(/\n\n+/)) dispatchSseBlock(block, onJson);
    return;
  }
  try { onJson(JSON.parse(text)); } catch { throw new Error('模型响应不是有效 JSON'); }
}

function contentType(response) {
  const headers = response?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get('content-type') || '';
  return headers['content-type'] || headers['Content-Type'] || '';
}

function looksLikeSse(text) {
  const start = String(text || '').trimStart();
  return start.startsWith('data:') || start.startsWith('event:');
}

function dispatchSseBlock(block, onJson) {
  for (const line of String(block).split(/\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try { onJson(JSON.parse(raw)); } catch { /* skip malformed */ }
  }
}

export function boundTools(ctx, nativeTools = []) {
  if (ctx?.compacting) return [];
  const extra = Array.isArray(ctx?.extraTools) ? ctx.extraTools : [];
  if (ctx?.managerIdle) return extra;
  return [...nativeTools, ...extra];
}

export function strProp(description) { return { type: 'STRING', description }; }
export function intProp(description) { return { type: 'INTEGER', description }; }
export function boolProp(description) { return { type: 'BOOLEAN', description }; }
export function objProp(description, properties, required = []) {
  return { type: 'OBJECT', description, properties, required };
}
export function arrProp(description, items) {
  return { type: 'ARRAY', description, items };
}

export function geminiTool(name, description, properties, required = []) {
  return { name, description, parameters: { type: 'OBJECT', properties, required } };
}

export function claudeTool(name, description, properties, required = []) {
  const schema = { type: 'object', properties: jsonSchema(properties), required };
  return { name, description, input_schema: schema };
}

export function openaiTool(name, description, properties, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: jsonSchema(properties), required },
    },
  };
}

export function responsesTool(name, description, properties, required = []) {
  return {
    type: 'function',
    name,
    description,
    parameters: { type: 'object', properties: jsonSchema(properties), required },
  };
}

function jsonSchema(properties) {
  const out = {};
  for (const [key, value] of Object.entries(properties || {})) {
    out[key] = toJsonSchema(value);
  }
  return out;
}

function toJsonSchema(value) {
  if (!value || typeof value !== 'object') return { type: 'string' };
  const type = String(value.type || 'STRING').toLowerCase();
  const next = { ...value, type };
  if (value.properties) next.properties = jsonSchema(value.properties);
  if (value.items) next.items = toJsonSchema(value.items);
  return next;
}

export function arg(args, ...keys) {
  for (const key of keys) {
    if (args?.[key] !== undefined && args[key] !== null && args[key] !== '') return args[key];
  }
  return undefined;
}

export function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

export function parseToolArgs(name, argsText, inputText = '') {
  const raw = String(argsText || '');
  const input = String(inputText || '');
  const parsed = asObject(raw);
  if (name === 'apply_patch') {
    if (input) return { input };
    if (parsed.input || parsed.patch) return parsed;
    if (raw && !raw.trim().startsWith('{')) return { input: raw };
    return parsed;
  }
  if (Object.keys(parsed).length) return parsed;
  if (input) return name === 'exec_command' ? { cmd: input } : { input };
  if (raw && !raw.trim().startsWith('{')) {
    return name === 'exec_command' ? { cmd: raw } : { input: raw };
  }
  return parsed;
}

export function responsesCallBag() {
  const partial = new Map();

  function take(tc, idx) {
    const callId = String(tc.id || tc.call_id || '').trim();
    const itemId = String(tc.item_id || '').trim();
    const indexKey = idx === undefined || idx === null ? '' : `idx:${idx}`;
    const keys = [callId, itemId, indexKey].filter(Boolean);
    if (!keys.length) return;
    let cur = null;
    for (const k of keys) {
      if (partial.has(k)) {
        cur = partial.get(k);
        break;
      }
    }
    if (!cur) cur = { id: '', name: '', argsText: '', inputText: '' };
    if (callId) cur.id = callId;
    else if (itemId && !cur.id) cur.id = itemId;
    if (tc.name) cur.name = tc.name;
    if (tc.replaceArgs != null && tc.replaceArgs !== '') cur.argsText = String(tc.replaceArgs);
    else if (tc.appendArgs) cur.argsText += tc.appendArgs;
    if (tc.replaceInput != null && tc.replaceInput !== '') cur.inputText = String(tc.replaceInput);
    else if (tc.appendInput) cur.inputText += tc.appendInput;
    for (const k of keys) partial.set(k, cur);
  }

  function takeItem(item, idx) {
    if (!item) return;
    const named = item.type === 'function_call' || item.type === 'custom_tool_call' || item.name;
    if (!named) return;
    take({
      id: item.call_id,
      item_id: item.id,
      name: item.name,
      replaceArgs: item.arguments != null && item.arguments !== '' ? String(item.arguments) : undefined,
      replaceInput: typeof item.input === 'string' && item.input ? item.input : undefined,
    }, idx);
  }

  function ingest(zoned) {
    const type = zoned?.type;
    if (type === 'response.function_call_arguments.delta' && zoned.delta) {
      take({
        item_id: zoned.item_id,
        id: zoned.call_id,
        name: zoned.name,
        appendArgs: String(zoned.delta),
      }, zoned.output_index);
      return true;
    }
    if (type === 'response.function_call_arguments.done') {
      take({
        item_id: zoned.item_id,
        id: zoned.call_id,
        name: zoned.name,
        replaceArgs: zoned.arguments ? String(zoned.arguments) : undefined,
      }, zoned.output_index);
      return true;
    }
    if (type === 'response.custom_tool_call_input.delta' && zoned.delta) {
      take({
        item_id: zoned.item_id,
        id: zoned.call_id,
        name: zoned.name,
        appendInput: String(zoned.delta),
      }, zoned.output_index);
      return true;
    }
    if (type === 'response.custom_tool_call_input.done') {
      take({
        item_id: zoned.item_id,
        id: zoned.call_id,
        name: zoned.name,
        replaceInput: zoned.input ? String(zoned.input) : undefined,
      }, zoned.output_index);
      return true;
    }
    return false;
  }

  function flush() {
    const seen = new Set();
    const toolCalls = [];
    for (const cur of partial.values()) {
      if (!cur.name || seen.has(cur)) continue;
      seen.add(cur);
      toolCalls.push({
        id: cur.id || `call_${crypto.randomUUID()}`,
        name: cur.name,
        args: parseToolArgs(cur.name, cur.argsText, cur.inputText),
      });
    }
    return toolCalls;
  }

  return { take, takeItem, ingest, flush };
}
