import { applyRequestTimezone, applyResponseTimezone } from '../session-timezone.mjs';
import { consumeSse, boundTools, asObject, parseToolArgs, responsesCallBag } from './stream.mjs';
import { environmentBlock } from './context.mjs';
import { compactSystemPrompt } from './compact.mjs';

export const VENDOR = 'custom';
export const RISK = {};

export function tools() {
  return [];
}

const FAMILY_PROMPT = {
  claude: 'You are a Claude-family coding agent in the Agents workbench. This custom endpoint is in the Claude group. Use Claude Code tool names (Read, Edit, Write, Glob, Grep, Bash, PowerShell). You have those tools — do not say file tools are unavailable.',
  codex: 'You are a Codex-family coding agent in the Agents workbench. This custom endpoint is in the Codex group. Use exec_command, write_stdin, and apply_patch. You have those tools — do not say you cannot edit files.',
  agy: 'You are a Gemini-family coding agent in the Agents workbench. This custom endpoint is in the Gemini group. Use view_file, write_to_file, replace_file_content, run_command. You have those tools — do not say file tools are unavailable.',
  grok: 'You are a Grok-family coding agent in the Agents workbench. This custom endpoint is in the Grok group. Use read_file, write, search_replace, run_terminal_command. You have those tools — do not say file tools are unavailable.',
};

export function systemPrompt(ctx) {
  if (ctx.compacting) return compactSystemPrompt(ctx.compactKeepNote);
  if (ctx.managerIdle) {
    return [ctx.managerNote || '', environmentBlock(ctx)].filter(Boolean).join('\n\n');
  }
  const familyNote = FAMILY_PROMPT[ctx.toolFamily];
  if (familyNote) {
    return [familyNote, ctx.managerNote || '', environmentBlock(ctx)].filter(Boolean).join('\n\n');
  }
  return [
    'You are a custom-provider assistant in the Agents workbench.',
    'This connection is protocol-compatible chat only. There is no Claude/Codex/agy/Grok local tool surface.',
    'Do not invent apply_patch, view_file, or Read tools.',
    ctx.managerNote || '',
    environmentBlock(ctx),
  ].join('\n\n');
}

function openaiHistory(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content || '' });
      continue;
    }
    if (m.role !== 'assistant') continue;
    const tool_calls = (m.toolCalls || []).map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}),
      },
    }));
    out.push({
      role: 'assistant',
      content: m.content || (tool_calls.length ? null : ''),
      ...(tool_calls.length ? { tool_calls } : {}),
    });
    for (const tr of m.toolResults || []) {
      out.push({
        role: 'tool',
        tool_call_id: tr.toolCallId,
        content: String(tr.output || tr.error || ''),
      });
    }
  }
  return out;
}

function anthropicHistory(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content || '' });
      continue;
    }
    if (m.role !== 'assistant') continue;
    const content = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const tc of m.toolCalls || []) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: asObject(tc.args) });
    }
    out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
    if (m.toolResults?.length) {
      out.push({
        role: 'user',
        content: m.toolResults.map(tr => ({
          type: 'tool_result',
          tool_use_id: tr.toolCallId,
          content: String(tr.output || tr.error || ''),
          is_error: Boolean(tr.error && !tr.output),
        })),
      });
    }
  }
  return out;
}

function responsesInput(messages) {
  const input = [];
  for (const m of messages || []) {
    if (m.role === 'user') {
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: m.content || '' }] });
      continue;
    }
    if (m.role !== 'assistant') continue;
    if (m.content) {
      input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
    }
    for (const tc of m.toolCalls || []) {
      input.push({
        type: 'function_call',
        call_id: tc.id,
        name: tc.name,
        arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || {}),
      });
    }
    for (const tr of m.toolResults || []) {
      input.push({
        type: 'function_call_output',
        call_id: tr.toolCallId,
        output: String(tr.output || tr.error || ''),
      });
    }
  }
  return input;
}

function responsesOutputText(event) {
  const bags = [event];
  if (event?.response && typeof event.response === 'object') bags.push(event.response);
  for (const bag of bags) {
    if (typeof bag.output_text === 'string' && bag.output_text) return bag.output_text;
  }
  const parts = [];
  for (const bag of bags) {
    if (Array.isArray(bag.output)) {
      for (const item of bag.output) {
        if (typeof item?.content === 'string') parts.push(item.content);
        else if (Array.isArray(item?.content)) {
          for (const block of item.content) {
            const t = block?.text || block?.output_text || '';
            if (t) parts.push(t);
          }
        }
      }
    }
    if (bag.item?.type === 'message' && Array.isArray(bag.item.content)) {
      for (const part of bag.item.content) {
        if (part.type === 'output_text' && part.text) parts.push(part.text);
      }
    }
  }
  return parts.join('');
}

export async function stream(ctx, { messages, onText, onToolCall }) {
  const protocol = ctx.protocol || 'openai';
  const key = ctx.apiKey;
  if (!key) throw new Error('请先保存 API Key');
  let url = String(ctx.baseUrl || '').replace(/\/+$/, '');
  let headers = { 'Content-Type': 'application/json' };
  let payload;
  const extra = boundTools(ctx, ctx.familyTools || []);
  if (protocol === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    url += '/messages';
    payload = {
      model: ctx.model,
      max_tokens: 4096,
      stream: true,
      system: systemPrompt(ctx),
      messages: anthropicHistory(messages),
    };
    if (extra.length) payload.tools = extra;
  } else if (protocol === 'responses') {
    headers.Authorization = `Bearer ${key}`;
    headers.Accept = 'text/event-stream';
    url += '/responses';
    payload = {
      model: ctx.model,
      instructions: systemPrompt(ctx),
      input: responsesInput(messages),
      stream: true,
      store: false,
    };
    if (ctx.effort) payload.reasoning = { effort: ctx.effort };
    if (extra.length) payload.tools = extra;
  } else {
    headers.Authorization = `Bearer ${key}`;
    url += '/chat/completions';
    payload = {
      model: ctx.model,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt(ctx) }, ...openaiHistory(messages)],
    };
    if (extra.length) payload.tools = extra;
  }
  const response = await ctx.fetcher(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(applyRequestTimezone(payload, ctx.timezone)),
    signal: ctx.abortSignal || AbortSignal.timeout(180000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`供应商返回 HTTP ${response.status}`);
  let text = '';
  let streamed = false;
  const toolCalls = [];
  const partial = new Map();
  const bag = responsesCallBag();
  const takeTool = (tc, idx) => {
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
    if (tc.name || tc.function?.name) cur.name = tc.name || tc.function.name;
    if (tc.replaceArgs != null && tc.replaceArgs !== '') cur.argsText = String(tc.replaceArgs);
    else if (tc.function?.arguments) cur.argsText += tc.function.arguments;
    else if (typeof tc.input === 'string' && tc.input) cur.inputText += tc.input;
    else if (tc.input && typeof tc.input === 'object' && Object.keys(tc.input).length) {
      cur.argsText = JSON.stringify(tc.input);
    }
    for (const k of keys) partial.set(k, cur);
  };
  const takeOutputItem = (item, idx) => {
    if (!item) return;
    bag.takeItem(item, idx);
    if (item.type === 'message' && Array.isArray(item.content) && !streamed) {
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text && !text.includes(part.text)) {
          text += part.text;
          onText?.(part.text);
        }
      }
    }
  };
  await consumeSse(response, event => {
    const zoned = applyResponseTimezone(event, ctx.timezone);
    if (zoned.type === 'response.output_text.delta' && typeof zoned.delta === 'string' && zoned.delta) {
      streamed = true;
      text += zoned.delta;
      onText?.(zoned.delta);
      return;
    }
    if (bag.ingest(zoned)) return;
    if (zoned.type === 'response.output_item.done' || zoned.type === 'response.output_item.added') {
      takeOutputItem(zoned.item || {}, zoned.output_index);
      return;
    }
    if (Array.isArray(zoned.output) || Array.isArray(zoned.response?.output)) {
      for (const item of zoned.output || zoned.response.output) takeOutputItem(item);
    }
    const choice = zoned.choices?.[0];
    const delta = choice?.delta || choice?.message || {};
    const fromOpenAi = delta.content;
    if (typeof fromOpenAi === 'string' && fromOpenAi) { text += fromOpenAi; onText?.(fromOpenAi); streamed = true; }
    for (const tc of delta.tool_calls || []) takeTool(tc, tc.index ?? 0);
    if (zoned.type === 'content_block_start' && zoned.content_block?.type === 'tool_use') {
      takeTool({ id: zoned.content_block.id, name: zoned.content_block.name, input: zoned.content_block.input }, zoned.index ?? 0);
    }
    const fromClaude = zoned.delta?.text;
    if (typeof fromClaude === 'string' && fromClaude) { text += fromClaude; onText?.(fromClaude); streamed = true; }
    if (zoned.delta?.type === 'input_json_delta' && zoned.delta.partial_json) {
      takeTool({ function: { arguments: zoned.delta.partial_json } }, zoned.index ?? 0);
    }
    if (zoned.content_block?.type === 'tool_use') takeTool(zoned.content_block, zoned.index ?? 0);
    if (streamed) return;
    const fromResponses = responsesOutputText(zoned);
    if (fromResponses && !text.includes(fromResponses)) {
      text += fromResponses;
      onText?.(fromResponses);
    }
  });
  const seen = new Set();
  for (const cur of partial.values()) {
    if (!cur.name || seen.has(cur)) continue;
    seen.add(cur);
    const item = {
      id: cur.id || `call_${crypto.randomUUID()}`,
      name: cur.name,
      args: parseToolArgs(cur.name, cur.argsText, cur.inputText),
    };
    toolCalls.push(item);
    onToolCall?.(item);
  }
  for (const item of bag.flush()) {
    if (toolCalls.some(t => t.id === item.id && t.name === item.name)) continue;
    toolCalls.push(item);
    onToolCall?.(item);
  }
  return { text, thoughts: '', toolCalls };
}

export async function execute() {
  return { ok: false, error: 'Custom providers have no local agent tools' };
}

export function summarize(name) {
  return `调用 ${name}`;
}
