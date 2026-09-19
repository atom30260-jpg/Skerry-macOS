import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMPACT_RATIO,
  buildCompactSummary,
  compactTranscript,
  estimateTokens,
  measureContext,
  resolveContextWindow,
} from './compact.mjs';
import { toMessages as claudeToMessages } from './claude.mjs';
import { toMessages as grokToMessages } from './grok.mjs';
import { toContents as agyToContents } from './agy.mjs';
import { toInput as codexToInput, execute as codexExecute } from './codex.mjs';
import { stream as customStream } from './custom.mjs';
import { runTurn } from './loop.mjs';
import { loadTranscript, saveTranscript } from './store.mjs';
import { ensureManagerPartition } from '../core.mjs';
import { resolveCloneSlot, resolveDispatchTarget } from './dispatch.mjs';
import { handleHistory, handleGroupHistory } from './chat.mjs';

function filler(label, n = 400) {
  return `${label} ${'x'.repeat(n)}`;
}

function history(n, { first = 'UNIQUE_OLD_TURN', last = 'KEEP_LAST' } = {}) {
  const messages = [];
  for (let i = 0; i < n; i += 1) {
    messages.push({ role: 'user', content: i === 0 ? filler(first) : filler(`user-${i}`) });
    messages.push({
      role: 'assistant',
      content: filler(`assistant-${i}`),
      toolCalls: i === 1 ? [{ id: 'c1', name: 'Write', args: { file_path: 'loop.py' } }] : [],
      toolResults: i === 1 ? [{ toolCallId: 'c1', toolName: 'Write', output: 'ok' }] : [],
    });
  }
  messages.push({ role: 'user', content: last });
  return messages;
}

function sseOk(events) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    async text() {
      return events.map(event => `data: ${JSON.stringify(event)}`).join('\n\n') + '\n\n';
    },
  };
}

test('90% 阈值按窗口计算，未到点不压', () => {
  assert.equal(COMPACT_RATIO, 0.9);
  const window = 1000;
  const under = measureContext({ messages: 'a'.repeat(800 * 4), window });
  assert.equal(under.shouldCompact, false);
  assert.equal(under.trigger, 900);
  const over = measureContext({ messages: 'a'.repeat(900 * 4), window });
  assert.equal(over.shouldCompact, true);
  assert.equal(measureContext({ messages: 'a'.repeat(10000), window: 0 }).shouldCompact, false);
});

test('中文按约 1 token 估，ASCII 按约 4 字 1 token', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.ok(estimateTokens('压缩上下文') >= 5);
});

test('contextWindow 优先用本轮覆盖，其次型号目录，再次分组配置', () => {
  const connection = {
    modelConfigs: {
      grok: {
        contextWindow: 131072,
        defaultModel: 'grok-4.6',
        catalog: [
          { model: 'grok-4.6', contextWindow: 200000 },
          { model: 'grok-4.5', contextWindow: 128000 },
        ],
      },
    },
  };
  assert.equal(resolveContextWindow({ contextWindow: 64000, connection, model: 'grok-4.6' }), 64000);
  assert.equal(resolveContextWindow({ connection, model: 'grok-4.6' }), 200000);
  assert.equal(resolveContextWindow({ connection, model: 'grok-4.5' }), 128000);
  assert.equal(resolveContextWindow({
    connection: { modelConfigs: { claude: { env: { ANTHROPIC_MODEL: 'claude-sonnet-5' }, contextWindow: 200000 } } },
    model: 'claude-sonnet-5',
  }), 200000);
  assert.equal(resolveContextWindow({ connection: {}, model: 'x' }), 0);
});

test('压缩保留当前用户话，丢掉旧轮，并写入摘要', () => {
  const transcript = {
    messages: history(12),
    plan: 'ship compact',
    todos: [{ content: 'write tests', status: 'completed' }],
  };
  const result = compactTranscript(transcript);
  assert.equal(result.compacted, true);
  assert.ok(result.dropped >= 6);
  assert.equal(transcript.messages[0].kind, 'compaction');
  assert.equal(transcript.messages[0].role, 'user');
  assert.equal(transcript.messages[1].kind, 'compaction');
  assert.equal(transcript.messages[1].role, 'assistant');
  assert.equal(transcript.messages.at(-1).content, 'KEEP_LAST');
  assert.equal(transcript.messages.filter(m => m.kind !== 'compaction').length, 1);
  assert.match(transcript.messages[0].content, /same session/);
  assert.match(transcript.messages[0].content, /loop\.py/);
  assert.doesNotMatch(transcript.messages.map(m => m.content).join('\n'), /UNIQUE_OLD_TURN/);
  assert.equal(compactTranscript(transcript).compacted, false);
});

test('各渠道历史转换都能吃下压缩后的消息', () => {
  const transcript = { messages: history(4) };
  compactTranscript(transcript);
  const claude = claudeToMessages(transcript.messages);
  assert.equal(claude[0].role, 'user');
  assert.equal(claude[1].role, 'assistant');
  assert.equal(claude[2].role, 'user');
  const grok = grokToMessages(transcript.messages);
  assert.equal(grok[1].role, 'user');
  assert.equal(grok[2].role, 'assistant');
  const gemini = agyToContents(transcript.messages);
  assert.equal(gemini[0].role, 'user');
  assert.equal(gemini[1].role, 'model');
  const responses = codexToInput(transcript.messages);
  assert.equal(responses[0].type, 'message');
  assert.equal(responses[0].role, 'user');
  assert.equal(responses[1].role, 'assistant');
});

test('runTurn 到 90% 先向上游跑 /compact 再续跑同一会话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-compact-'));
  const events = [];
  const payloads = [];
  const prior = history(12, { first: 'UNIQUE_OLD_TURN', last: 'please continue' });
  prior.pop();
  try {
    await runTurn({
      vendor: 'custom',
      protocol: 'openai',
      model: 'demo',
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      workspace: dir,
      dataDir: dir,
      sessionId: 's',
      targetId: 'manager',
      isManager: true,
      contextWindow: 2500,
      transcript: { version: 1, vendor: 'custom', mode: 'default', messages: prior, todos: [] },
      fetcher: async (_url, init) => {
        const payload = JSON.parse(init.body);
        payloads.push(payload);
        if (payloads.length === 1) {
          return sseOk([{ choices: [{ delta: { content: 'MODEL_SUMMARY_UNIQUE' } }] }]);
        }
        return sseOk([{ choices: [{ delta: { content: '续跑中' } }] }]);
      },
      emit: (event, data) => events.push({ event, data }),
      userText: 'please continue',
      maxTurns: 2,
    });
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].tools, undefined);
    assert.match(payloads[0].messages[0].content, /compacting this same agent session/);
    assert.match(JSON.stringify(payloads[0].messages), /Summarize earlier turns/);
    assert.match(JSON.stringify(payloads[0].messages), /UNIQUE_OLD_TURN/);
    assert.ok(events.some(e => e.event === 'compacted' && e.data.reason === 'threshold'));
    const body = JSON.stringify(payloads[1].messages);
    assert.match(body, /please continue/);
    assert.match(body, /MODEL_SUMMARY_UNIQUE/);
    assert.match(body, /Compacted context/);
    assert.doesNotMatch(body, /UNIQUE_OLD_TURN/);
    const saved = loadTranscript(dir, 's', 'manager', 'custom');
    assert.ok(saved.compactCount >= 1);
    assert.equal(saved.messages[0].name, 'threshold');
    assert.equal(saved.messages.at(-2).role, 'user');
    assert.equal(saved.messages.at(-2).content, 'please continue');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/compact 命令即使未到 90% 也会向上游要摘要', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-slash-compact-'));
  const events = [];
  const payloads = [];
  try {
    const result = await runTurn({
      vendor: 'custom',
      protocol: 'openai',
      model: 'demo',
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      workspace: dir,
      dataDir: dir,
      sessionId: 's',
      targetId: 'manager',
      isManager: true,
      contextWindow: 128000,
      transcript: { version: 1, vendor: 'custom', mode: 'default', messages: history(4), todos: [] },
      fetcher: async (_url, init) => {
        payloads.push(JSON.parse(init.body));
        return sseOk([{ choices: [{ delta: { content: 'SLASH_SUMMARY' } }] }]);
      },
      emit: (event, data) => events.push({ event, data }),
      userText: '/compact keep files only',
      maxTurns: 2,
    });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].tools, undefined);
    assert.match(payloads[0].messages[0].content, /Keep note: keep files only/);
    assert.equal(result.compacted, true);
    assert.ok(events.some(e => e.event === 'compacted' && e.data.reason === 'command'));
    const saved = loadTranscript(dir, 's', 'manager', 'custom');
    assert.equal(saved.messages[0].name, 'command');
    assert.match(saved.messages[0].content, /SLASH_SUMMARY/);
    assert.equal(saved.messages.at(-1).content, 'KEEP_LAST');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('上游压缩失败时回退本地摘要再续跑', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-compact-fallback-'));
  const events = [];
  let turnPayload;
  const prior = history(12, { first: 'UNIQUE_OLD_TURN', last: 'please continue' });
  prior.pop();
  try {
    await runTurn({
      vendor: 'custom',
      protocol: 'openai',
      model: 'demo',
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      workspace: dir,
      dataDir: dir,
      sessionId: 's',
      targetId: 'partition-w1',
      contextWindow: 2500,
      transcript: { version: 1, vendor: 'custom', mode: 'default', messages: prior, todos: [] },
      fetcher: async (_url, init) => {
        if (!turnPayload) {
          turnPayload = 'compact-fail';
          throw new Error('compact upstream failed');
        }
        turnPayload = JSON.parse(init.body);
        return sseOk([{ choices: [{ delta: { content: '续跑中' } }] }]);
      },
      emit: (event, data) => events.push({ event, data }),
      userText: 'please continue',
      maxTurns: 2,
    });
    assert.ok(events.some(e => e.event === 'compacted'));
    const body = JSON.stringify(turnPayload.messages);
    assert.match(body, /Compacted context/);
    assert.match(body, /please continue/);
    assert.doesNotMatch(body, /UNIQUE_OLD_TURN/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未到 90% 不压缩', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-nocompact-'));
  const events = [];
  try {
    await runTurn({
      vendor: 'custom',
      protocol: 'openai',
      model: 'demo',
      apiKey: 'k',
      baseUrl: 'https://api.example.com/v1',
      workspace: dir,
      dataDir: dir,
      sessionId: 's',
      targetId: 'partition-w1',
      contextWindow: 128000,
      transcript: { version: 1, vendor: 'custom', mode: 'default', messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'ok' }], todos: [] },
      fetcher: async () => sseOk([{ choices: [{ delta: { content: 'hi' } }] }]),
      emit: (event, data) => events.push({ event, data }),
      userText: 'next',
      maxTurns: 2,
    });
    assert.ok(!events.some(e => e.event === 'compacted'));
    const saved = loadTranscript(dir, 's', 'partition-w1', 'custom');
    assert.equal(saved.messages[0].content, 'old');
    assert.equal(saved.compactCount || 0, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('自定义 Responses / Anthropic 压缩后仍是合法历史', async () => {
  const transcript = { messages: history(5) };
  compactTranscript(transcript);
  let responsesBody;
  let anthropicBody;
  await customStream({
    protocol: 'responses',
    apiKey: 'k',
    baseUrl: 'https://api.example.com/v1',
    model: 'g',
    fetcher: async (_url, init) => {
      responsesBody = JSON.parse(init.body);
      return sseOk([{ type: 'response.output_text.delta', delta: 'ok' }]);
    },
  }, { messages: transcript.messages, onText() {}, onToolCall() {} });
  await customStream({
    protocol: 'anthropic',
    apiKey: 'k',
    baseUrl: 'https://api.example.com/v1',
    model: 'c',
    fetcher: async (_url, init) => {
      anthropicBody = JSON.parse(init.body);
      return sseOk([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }]);
    },
  }, { messages: transcript.messages, onText() {}, onToolCall() {} });
  assert.equal(responsesBody.input[0].role, 'user');
  assert.equal(responsesBody.input[1].role, 'assistant');
  assert.equal(anthropicBody.messages[0].role, 'user');
  assert.equal(anthropicBody.messages[1].role, 'assistant');
  assert.equal(anthropicBody.messages[2].role, 'user');
});

test('空闲工人复用同一 partition，就是续跑同一份 transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-reuse-'));
  try {
    const session = { partitions: [] };
    ensureManagerPartition(session);
    const grok = {
      id: 'official-grok',
      name: 'Grok',
      connected: true,
      expired: false,
      modelConfigs: { grok: { defaultModel: 'grok-4.6', contextWindow: 131072 } },
    };
    const state = { connections: [], officialModelConfigs: { 'official-grok': grok.modelConfigs } };
    const statuses = () => [grok];
    const first = resolveDispatchTarget({
      session, state, statuses, hasSecret: () => false, connectionId: 'official-grok', partitionId: '', model: 'grok-4.6', busyIds: new Set(),
    });
    assert.equal(first.reused, false);
    saveTranscript(dir, 's1', `partition-${first.partition.id}`, {
      version: 1,
      vendor: 'grok',
      mode: 'default',
      messages: [{ role: 'user', content: 'first job' }, { role: 'assistant', content: 'done 1' }],
      todos: [],
    });
    const second = resolveDispatchTarget({
      session, state, statuses, hasSecret: () => false, connectionId: 'official-grok', partitionId: '', model: 'grok-4.6', busyIds: new Set(),
    });
    assert.equal(second.ok, true);
    assert.equal(second.reused, true);
    assert.equal(second.partition.id, first.partition.id);
    const loaded = loadTranscript(dir, 's1', `partition-${second.partition.id}`, 'grok');
    assert.equal(loaded.messages[0].content, 'first job');
    const busy = resolveDispatchTarget({
      session, state, statuses, hasSecret: () => false, connectionId: 'official-grok', partitionId: '', model: 'grok-4.6', busyIds: new Set([first.partition.id]),
    });
    assert.notEqual(busy.partition.id, first.partition.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('分身复用空闲槽续跑同一份 transcript，管理者始终是 manager.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-clone-reuse-'));
  try {
    const session = { partitions: [] };
    ensureManagerPartition(session);
    const first = resolveCloneSlot({ session, connectionId: 'official-grok', model: 'grok-4.6', busyIds: new Set() });
    saveTranscript(dir, 's1', `partition-${first.partition.id}`, {
      version: 1, vendor: 'grok', mode: 'default', messages: [{ role: 'user', content: 'clone A' }], todos: [],
    });
    saveTranscript(dir, 's1', 'manager', {
      version: 1, vendor: 'grok', mode: 'default', messages: [{ role: 'user', content: 'manager turn' }], todos: [],
    });
    const again = resolveCloneSlot({ session, connectionId: 'official-grok', model: 'grok-4.6', busyIds: new Set() });
    assert.equal(again.partition.id, first.partition.id);
    const cloneLoaded = loadTranscript(dir, 's1', `partition-${again.partition.id}`, 'grok');
    assert.equal(cloneLoaded.messages[0].content, 'clone A');
    const managerLoaded = loadTranscript(dir, 's1', 'manager', 'grok');
    assert.equal(managerLoaded.messages[0].content, 'manager turn');
    assert.notEqual(cloneLoaded.messages[0].content, managerLoaded.messages[0].content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('history 返回该分区上下文额度，群聊用管理者窗口', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-quota-'));
  try {
    const session = { id: 's', partitions: [{ id: 'p1', role: 'execution', routes: [{ connectionId: 'g1', model: 'grok-4.6' }] }] };
    const state = {
      projects: [{ sessions: [session] }],
      connections: [{
        id: 'g1',
        name: 'Grok-测试',
        modelGroups: ['grok'],
        modelConfigs: { grok: { defaultModel: 'grok-4.6', contextWindow: 131072 } },
      }],
      manager: { connectionId: 'g1', model: 'grok-4.6', contextWindow: 200000 },
    };
    saveTranscript(dir, 's', 'manager', {
      version: 1, vendor: 'grok', mode: 'default',
      messages: [{ role: 'user', content: 'hello '.repeat(80) }],
      todos: [],
    });
    saveTranscript(dir, 's', 'partition-p1', {
      version: 1, vendor: 'grok', mode: 'default',
      messages: [{ role: 'user', content: 'job '.repeat(20) }],
      todos: [],
    });
    const managerHist = handleHistory({ dataDir: dir, state }, { sessionId: 's' });
    assert.equal(managerHist.context.window, 200000);
    assert.ok(managerHist.context.used > 0);
    assert.equal(managerHist.context.shouldCompact, false);
    const workerHist = handleHistory({ dataDir: dir, state }, { sessionId: 's', partitionId: 'p1' });
    assert.equal(workerHist.context.window, 131072);
    const groupHist = handleGroupHistory({ dataDir: dir, state }, { sessionId: 's' });
    assert.equal(groupHist.context.window, 200000);
    assert.equal(groupHist.mode, 'default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex get_context_remaining 返回窗口和已用量', async () => {
  const result = await codexExecute('get_context_remaining', {}, {
    transcript: { messages: [{ role: 'user', content: 'hi' }] },
    measureContext: () => ({ used: 900, window: 1000, remaining: 100, shouldCompact: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.window, 1000);
  assert.equal(result.used, 900);
  assert.equal(result.remaining, 100);
  assert.equal(result.messages, 1);
});

test('上游摘要写入会话，并带上 /compact 来源', () => {
  const transcript = { messages: history(3) };
  const result = compactTranscript(transcript, { summary: 'MODEL_ONLY', reason: 'command' });
  assert.equal(result.compacted, true);
  assert.equal(transcript.messages[0].name, 'command');
  assert.match(transcript.messages[0].content, /Compacted context/);
  assert.match(transcript.messages[0].content, /MODEL_ONLY/);
});

test('摘要保留待办和派工结果，不把整段工具输出塞回去', () => {
  const text = buildCompactSummary([
    { role: 'user', content: '改入口' },
    { role: 'assistant', content: '已改', kind: 'dispatch_result', name: 'Grok', toolCalls: [{ name: 'read_file', args: { path: 'src/app.js' } }], toolResults: [{ output: 'x'.repeat(8000) }] },
  ], { todos: [{ content: 'verify', status: 'pending' }] });
  assert.match(text, /改入口/);
  assert.match(text, /dispatch_result Grok/);
  assert.match(text, /src\/app\.js/);
  assert.match(text, /verify/);
  assert.doesNotMatch(text, /x{100}/);
});
