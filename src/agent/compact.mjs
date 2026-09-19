export const COMPACT_RATIO = 0.9;
export const COMPACT_KIND = 'compaction';
export const COMPACT_USER_PROMPT = 'Summarize earlier turns of this same session. Output only the summary.';
export const DEFAULT_COMPACT_KEEP = 'Keep the latest user request and current task. Discard prior compaction summaries and raw tool dumps. Short summary only.';

const SUMMARY_CHAR_CAP = 12000;
const COMPACT_ACK = 'Continuing from the compacted context of this same session.';

export function compactSystemPrompt(keepNote = '') {
  return [
    'You are compacting this same agent session so it can continue in one context window.',
    'Write a dense summary of earlier turns. Keep user goals, decisions, file paths, commands, errors, todos, dispatch and clone outcomes.',
    'Discard raw tool dumps, repeated compaction summaries, and boilerplate.',
    'Do not call tools. Do not greet. Output only the summary. Target under 4000 tokens.',
    'This is the same session, not a new conversation.',
    keepNote ? `Keep note: ${keepNote}` : DEFAULT_COMPACT_KEEP,
  ].join('\n');
}

export function toWindow(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.floor(n);
}

export function estimateTokens(value) {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let tokens = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c <= 0x7F) tokens += 0.25;
    else if (c <= 0x7FF) tokens += 0.5;
    else tokens += 1;
  }
  return Math.ceil(tokens);
}

export function estimateRequestTokens({ messages, system = '', tools } = {}) {
  return estimateTokens(system) + estimateTokens(tools == null ? '' : tools) + estimateTokens(messages || []);
}

export function resolveContextWindow(ctx = {}) {
  const direct = toWindow(ctx.contextWindow);
  if (direct) return direct;
  const connection = ctx.connection || {};
  const configs = connection.modelConfigs && typeof connection.modelConfigs === 'object' && !Array.isArray(connection.modelConfigs)
    ? connection.modelConfigs
    : {};
  const model = String(ctx.model || '').trim();
  let configWindow = 0;
  for (const config of Object.values(configs)) {
    if (!config || typeof config !== 'object') continue;
    const cfgWindow = toWindow(config.contextWindow);
    if (cfgWindow && !configWindow) configWindow = cfgWindow;
    if (!model) continue;
    for (const row of config.catalog || []) {
      if (String(row?.model || '').trim() !== model) continue;
      const rowWindow = toWindow(row.contextWindow);
      if (rowWindow) return rowWindow;
    }
    const envHit = config.env && Object.values(config.env).some(v => String(v || '').trim() === model);
    if (envHit && cfgWindow) return cfgWindow;
    if (String(config.defaultModel || '').trim() === model && cfgWindow) return cfgWindow;
  }
  return configWindow;
}

export function measureContext({ messages, system = '', tools, window, threshold = COMPACT_RATIO } = {}) {
  const used = estimateRequestTokens({ messages, system, tools });
  const limit = toWindow(window);
  const trigger = limit ? Math.floor(limit * threshold) : 0;
  return {
    used,
    window: limit,
    trigger,
    remaining: limit ? Math.max(0, limit - used) : null,
    ratio: limit ? used / limit : 0,
    shouldCompact: Boolean(limit) && used >= trigger,
  };
}

function clip(text, n = 240) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function collectFiles(message) {
  const files = [];
  const scan = obj => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of ['file_path', 'TargetFile', 'AbsolutePath', 'path', 'target_file', 'filePath', 'file']) {
      const value = obj[key];
      if (value) files.push(String(value));
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') scan(value);
    }
  };
  for (const tc of message.toolCalls || []) scan(tc.args);
  return files;
}

export function buildCompactSummary(messages, transcript = {}) {
  const users = [];
  const outcomes = [];
  const tools = new Set();
  const files = new Set();
  for (const m of messages || []) {
    if (m?.kind === COMPACT_KIND) continue;
    if (m?.role === 'user' && m.content) users.push(clip(m.content, 400));
    if (m?.role !== 'assistant') continue;
    if (m.content) {
      const label = m.kind === 'dispatch_result' || m.kind === 'clone_result' || m.kind === 'job_error'
        ? `${m.kind}${m.name ? ` ${m.name}` : ''}: `
        : '';
      outcomes.push(clip(`${label}${m.content}`, 400));
    }
    for (const tc of m.toolCalls || []) {
      if (tc.name) tools.add(tc.name);
    }
    for (const file of collectFiles(m)) files.add(file);
  }
  const lines = [
    '[Compacted context]',
    'Earlier turns in this same session were compacted at 90% of the context window. Continue this session. Do not treat this as a new conversation.',
  ];
  if (users.length) {
    lines.push('', '## User requests');
    for (const item of users.slice(-8)) lines.push(`- ${item}`);
  }
  if (outcomes.length) {
    lines.push('', '## Outcomes');
    for (const item of outcomes.slice(-8)) lines.push(`- ${item}`);
  }
  if (tools.size) {
    lines.push('', '## Tools used', [...tools].slice(0, 24).join(', '));
  }
  if (files.size) {
    lines.push('', '## Files');
    for (const file of [...files].slice(-16)) lines.push(`- ${file}`);
  }
  if (transcript.plan) {
    lines.push('', '## Plan', clip(transcript.plan, 1200));
  }
  if (Array.isArray(transcript.todos) && transcript.todos.length) {
    lines.push('', '## Todos');
    for (const todo of transcript.todos.slice(0, 20)) {
      const done = todo.status === 'completed' || todo.status === 'complete' || todo.status === 'done';
      lines.push(`- [${done ? 'x' : ' '}] ${clip(todo.content || todo.title || todo.step || '', 200)}`);
    }
  }
  let text = lines.join('\n');
  if (text.length > SUMMARY_CHAR_CAP) text = `${text.slice(0, SUMMARY_CHAR_CAP - 1)}…`;
  return text;
}

function compactionEntry(role, content, extra = {}) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    thoughts: '',
    toolCalls: [],
    toolResults: [],
    model: '',
    requestModel: '',
    effort: '',
    timestamp: new Date().toISOString(),
    usage: null,
    finishReason: '',
    kind: COMPACT_KIND,
    name: extra.name || '',
    status: '',
  };
}

function lastLiveUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === 'user' && m.kind !== COMPACT_KIND) return i;
  }
  return -1;
}

export function splitForCompact(messages = []) {
  const lastUser = lastLiveUserIndex(messages);
  if (lastUser < 0) return { older: [], kept: [...messages], lastUser };
  return { older: messages.slice(0, lastUser), kept: messages.slice(lastUser), lastUser };
}

export function wrapCompactSummary(text) {
  const body = String(text || '').trim();
  const header = [
    '[Compacted context]',
    'Earlier turns in this same session were compacted. Continue this session. Do not treat this as a new conversation.',
  ].join('\n');
  const out = !body
    ? header
    : (body.includes('[Compacted context]') ? body : `${header}\n\n${body}`);
  return out.length > SUMMARY_CHAR_CAP ? `${out.slice(0, SUMMARY_CHAR_CAP - 1)}…` : out;
}

export function compactTranscript(transcript, { summary, reason } = {}) {
  if (!transcript || !Array.isArray(transcript.messages)) return { compacted: false, dropped: 0 };
  const { older, kept, lastUser } = splitForCompact(transcript.messages);
  if (lastUser < 0) return { compacted: false, dropped: 0 };
  const meaningful = older.filter(m => m?.kind !== COMPACT_KIND);
  if (!meaningful.length) return { compacted: false, dropped: 0 };
  const text = wrapCompactSummary(summary || buildCompactSummary(older, transcript));
  const name = reason || '';
  transcript.messages = [
    compactionEntry('user', text, { name }),
    compactionEntry('assistant', COMPACT_ACK, { name }),
    ...kept,
  ];
  transcript.compactedAt = Date.now();
  transcript.compactCount = (transcript.compactCount || 0) + 1;
  return { compacted: true, dropped: older.length, kept: kept.length, compactCount: transcript.compactCount, reason: name };
}
