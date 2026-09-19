import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureManagerPartition, isClonePartition } from '../core.mjs';
import { boundTools } from './stream.mjs';
import { capabilityPool, matchPoolEntry, preferActiveRoute, resolveCloneSlot, resolveDispatchTarget } from './dispatch.mjs';
import { loadGroupTimeline, saveGroupTimeline, appendGroupEvent, upsertTaskEvent, abortTaskEvents } from './store.mjs';
import { handleAbort } from './chat.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Grok 管理者派 Grok 得到 execution 而不是 clone', () => {
  const session = { partitions: [] };
  ensureManagerPartition(session);
  const connection = {
    id: 'official-grok',
    name: 'Grok',
    connected: true,
    expired: false,
    modelConfigs: { grok: { defaultModel: 'grok-4' } },
  };
  const state = { connections: [], officialModelConfigs: { 'official-grok': connection.modelConfigs } };
  const statuses = () => [connection];
  const result = resolveDispatchTarget({
    session,
    state,
    statuses,
    hasSecret: () => false,
    connectionId: 'official-grok',
    partitionId: '',
    model: '',
    busyIds: new Set(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.partition.role, 'execution');
  assert.equal(isClonePartition(result.partition), false);
  assert.equal(result.partition.name, 'Grok');
  const pool = capabilityPool(state, statuses, () => false);
  assert.equal(pool[0].connectionId, 'official-grok');
});

test('按连接名、产品标签或 prompt 子串命中能力池', () => {
  const pool = [
    { connectionId: 'official-grok', name: 'Grok', vendor: 'grok', vendorLabel: 'Grok', model: 'grok-4' },
    { connectionId: 'official-codex', name: 'Codex', vendor: 'codex', vendorLabel: 'Codex', model: 'gpt-5' },
    { connectionId: 'c682621f', name: 'kiro', vendor: 'custom', vendorLabel: 'kiro', model: 'claude-sonnet-5' },
  ];
  assert.equal(matchPoolEntry(pool, 'Grok').connectionId, 'official-grok');
  assert.equal(matchPoolEntry(pool, 'official-codex').connectionId, 'official-codex');
  assert.equal(matchPoolEntry(pool, 'kiro').connectionId, 'c682621f');
  assert.equal(matchPoolEntry(pool, '', 'Grok,帮我创建一个简单的循环Python脚本').connectionId, 'official-grok');
  assert.equal(matchPoolEntry(pool, '', '让 Codex 跑测试').connectionId, 'official-codex');
});

test('多连接时 prompt 写 Grok 仍能派到官方 Grok', () => {
  const session = { partitions: [] };
  ensureManagerPartition(session);
  const grok = {
    id: 'official-grok',
    name: 'Grok',
    connected: true,
    expired: false,
    modelConfigs: { grok: { defaultModel: 'grok-4' } },
  };
  const codex = {
    id: 'official-codex',
    name: 'Codex',
    connected: true,
    expired: false,
    modelConfigs: { codex: { defaultModel: 'gpt-5' } },
  };
  const state = {
    connections: [{ id: 'c682621f', name: 'kiro', protocol: 'responses', models: ['claude-sonnet-5'] }],
    officialModelConfigs: {
      'official-grok': grok.modelConfigs,
      'official-codex': codex.modelConfigs,
    },
  };
  const statuses = () => [grok, codex];
  const result = resolveDispatchTarget({
    session,
    state,
    statuses,
    hasSecret: id => id === 'c682621f',
    connectionId: '',
    partitionId: '',
    model: '',
    busyIds: new Set(),
    prompt: 'Grok,帮我创建一个简单的循环Python脚本',
  });
  assert.equal(result.ok, true);
  assert.equal(result.connectionId, 'official-grok');
  assert.equal(result.partition.role, 'execution');
  assert.equal(result.partition.name, 'Grok');
  const named = resolveDispatchTarget({
    session,
    state,
    statuses,
    hasSecret: id => id === 'c682621f',
    connectionId: 'Grok',
    partitionId: '',
    model: '',
    busyIds: new Set(),
    prompt: '写脚本',
  });
  assert.equal(named.ok, true);
  assert.equal(named.connectionId, 'official-grok');
});

test('Claude 分组的自定义连接按系列派工，标签不是连接名', () => {
  const session = { partitions: [] };
  ensureManagerPartition(session);
  const kiro = {
    id: 'c682',
    name: 'kiro',
    protocol: 'responses',
    models: ['claude-sonnet-5'],
    modelGroups: ['claude'],
    modelConfigs: { claude: { defaultModel: 'claude-sonnet-5' } },
  };
  const state = { connections: [kiro], officialModelConfigs: {} };
  const pool = capabilityPool(state, () => [], id => id === 'c682');
  assert.equal(pool.length, 1);
  assert.equal(pool[0].vendorLabel, 'Claude');
  assert.equal(pool[0].group, 'claude');
  assert.equal(pool[0].vendor, 'claude');
  assert.equal(matchPoolEntry(pool, 'Claude').connectionId, 'c682');
  assert.equal(matchPoolEntry(pool, '', '让 Claude 写个循环文件').connectionId, 'c682');
  const result = resolveDispatchTarget({
    session,
    state,
    statuses: () => [],
    hasSecret: id => id === 'c682',
    connectionId: 'Claude',
    partitionId: '',
    model: '',
    busyIds: new Set(),
    prompt: '写文件',
  });
  assert.equal(result.ok, true);
  assert.equal(result.connectionId, 'c682');
  assert.equal(result.partition.name, 'Claude');
});

test('系列名 Grok 命中当前使用的供应商，而不是官方同名连接', () => {
  const session = { partitions: [] };
  ensureManagerPartition(session);
  const grok = {
    id: 'official-grok',
    name: 'Grok',
    connected: true,
    expired: false,
    modelConfigs: { grok: { defaultModel: 'grok-4.6' } },
  };
  const custom = {
    id: 'ef807',
    name: 'Grok-测试',
    protocol: 'responses',
    models: ['grok-4.6'],
    modelGroups: ['grok'],
    modelConfigs: { grok: { defaultModel: 'grok-4.6' } },
  };
  const state = {
    connections: [custom],
    officialModelConfigs: { 'official-grok': grok.modelConfigs },
    activeProviders: { grok: 'ef807' },
  };
  const statuses = () => [grok];
  const hasSecret = id => id === 'ef807';
  const pool = capabilityPool(state, statuses, hasSecret);
  assert.equal(matchPoolEntry(pool, 'Grok').connectionId, 'ef807');
  assert.equal(matchPoolEntry(pool, '', 'Grok,帮我创建一个简单的循环Python脚本').connectionId, 'ef807');
  assert.equal(preferActiveRoute(pool, 'official-grok').connectionId, 'ef807');
  const named = resolveDispatchTarget({
    session, state, statuses, hasSecret, connectionId: 'Grok', partitionId: '', model: '', busyIds: new Set(), prompt: '写脚本',
  });
  assert.equal(named.ok, true);
  assert.equal(named.connectionId, 'ef807');
  assert.equal(named.partition.name, 'Grok');
});

test('同系列空闲执行会话会改接到当前使用的供应商', () => {
  const session = { partitions: [] };
  ensureManagerPartition(session);
  const grok = {
    id: 'official-grok',
    name: 'Grok',
    connected: true,
    expired: false,
    modelConfigs: { grok: { defaultModel: 'grok-4.6' } },
  };
  const custom = {
    id: 'ef807',
    name: 'Grok-测试',
    protocol: 'responses',
    models: ['grok-4.6'],
    modelGroups: ['grok'],
    modelConfigs: { grok: { defaultModel: 'grok-4.6' } },
  };
  const officialState = {
    connections: [custom],
    officialModelConfigs: { 'official-grok': grok.modelConfigs },
    activeProviders: {},
  };
  const first = resolveDispatchTarget({
    session,
    state: officialState,
    statuses: () => [grok],
    hasSecret: id => id === 'ef807',
    connectionId: 'official-grok',
    partitionId: '',
    model: 'grok-4.6',
    busyIds: new Set(),
  });
  assert.equal(first.connectionId, 'official-grok');
  const activeState = { ...officialState, activeProviders: { grok: 'ef807' } };
  const second = resolveDispatchTarget({
    session,
    state: activeState,
    statuses: () => [grok],
    hasSecret: id => id === 'ef807',
    connectionId: 'Grok',
    partitionId: '',
    model: '',
    busyIds: new Set(),
    prompt: '写文件',
  });
  assert.equal(second.ok, true);
  assert.equal(second.partition.id, first.partition.id);
  assert.equal(second.connectionId, 'ef807');
  assert.equal(second.partition.routes[0].connectionId, 'ef807');
});

test('忙碌的执行会话不会被复用，会另开一路', () => {
  const session = { partitions: [] };
  ensureManagerPartition(session);
  const connection = {
    id: 'official-grok',
    name: 'Grok',
    connected: true,
    expired: false,
    modelConfigs: { grok: { defaultModel: 'grok-4' } },
  };
  const state = { connections: [], officialModelConfigs: {} };
  const statuses = () => [connection];
  const first = resolveDispatchTarget({
    session, state, statuses, hasSecret: () => false, connectionId: 'official-grok', partitionId: '', model: 'grok-4', busyIds: new Set(),
  });
  const second = resolveDispatchTarget({
    session, state, statuses, hasSecret: () => false, connectionId: 'official-grok', partitionId: '', model: 'grok-4', busyIds: new Set([first.partition.id]),
  });
  assert.equal(second.ok, true);
  assert.notEqual(second.partition.id, first.partition.id);
  assert.equal(second.partition.name, 'Grok 2');
});

test('分身复用空闲槽，满员后拒绝，且不是 execution', () => {
  const session = { partitions: [] };
  ensureManagerPartition(session);
  const first = resolveCloneSlot({ session, connectionId: 'official-grok', model: 'grok-4', busyIds: new Set() });
  assert.equal(first.ok, true);
  assert.equal(first.partition.role, 'clone');
  const busy = new Set([first.partition.id]);
  const second = resolveCloneSlot({ session, connectionId: 'official-grok', model: 'grok-4', busyIds: busy });
  assert.equal(second.ok, true);
  busy.add(second.partition.id);
  const third = resolveCloneSlot({ session, connectionId: 'official-grok', model: 'grok-4', busyIds: busy });
  assert.equal(third.ok, false);
  const idle = resolveCloneSlot({ session, connectionId: 'official-grok', model: 'grok-4', busyIds: new Set([second.partition.id]) });
  assert.equal(idle.ok, true);
  assert.equal(idle.partition.id, first.partition.id);
});

test('管理者留白时 boundTools 只保留 overlay', () => {
  const native = [{ function: { name: 'read_file' } }];
  const extra = [{ function: { name: 'workbench_dispatch' } }];
  const idle = boundTools({ managerIdle: true, extraTools: extra }, native);
  assert.deepEqual(idle, extra);
  const worker = boundTools({ managerIdle: false, extraTools: extra }, native);
  assert.equal(worker.length, 2);
  assert.equal(worker[0].function.name, 'read_file');
});

test('群时间线任务卡片可更新且直出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-group-'));
  try {
    const tl = loadGroupTimeline(dir, 's1');
    appendGroupEvent(tl, { type: 'user', content: '让 Grok 改' });
    const task = upsertTaskEvent(tl, 't1', { kind: 'execution', status: 'running', name: 'Grok', summary: '改 X' });
    upsertTaskEvent(tl, 't1', { status: 'completed', summary: '已改完' });
    saveGroupTimeline(dir, 's1', tl);
    const loaded = loadGroupTimeline(dir, 's1');
    assert.equal(loaded.events[0].type, 'user');
    assert.equal(loaded.events.find(e => e.taskId === 't1').status, 'completed');
    assert.equal(loaded.events.find(e => e.taskId === 't1').id, task.id);
    appendGroupEvent(tl, { type: 'worker', name: 'Grok', status: 'completed', content: '已改完', taskId: 't1' });
    saveGroupTimeline(dir, 's1', tl);
    const withWorker = loadGroupTimeline(dir, 's1');
    assert.equal(withWorker.events.find(e => e.type === 'worker').content, '已改完');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('中止只动进行中的任务，执行间中止不影响其他工人', () => {
  const tl = { events: [] };
  upsertTaskEvent(tl, 't1', { kind: 'execution', status: 'running', partitionId: 'p1', source: 'manager' });
  upsertTaskEvent(tl, 't2', { kind: 'execution', status: 'running', partitionId: 'p2', source: 'user' });
  upsertTaskEvent(tl, 't3', { kind: 'execution', status: 'completed', partitionId: 'p1' });
  const groupAll = abortTaskEvents({ events: tl.events.map(e => ({ ...e })) }, () => true);
  assert.equal(groupAll.length, 2);
  assert.ok(groupAll.every(e => e.status === 'failed' && e.summary === '被用户中止'));
  const one = abortTaskEvents(tl, ev => ev.partitionId === 'p1');
  assert.equal(one.length, 1);
  assert.equal(one[0].taskId, 't1');
  assert.equal(tl.events.find(e => e.taskId === 't2').status, 'running');
  assert.equal(tl.events.find(e => e.taskId === 't3').status, 'completed');
});

test('handleAbort 群聊范围会把进行中任务标成被用户中止', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-abort-'));
  try {
    const tl = loadGroupTimeline(dir, 's1');
    upsertTaskEvent(tl, 't1', { kind: 'execution', status: 'running', partitionId: 'p1', summary: '改 X' });
    upsertTaskEvent(tl, 't2', { kind: 'execution', status: 'completed', partitionId: 'p2', summary: '好了' });
    saveGroupTimeline(dir, 's1', tl);
    const state = { projects: [{ sessions: [{ id: 's1', partitions: [{ id: 'p1', role: 'execution', name: 'Grok', routes: [] }] }] }] };
    const groupHit = handleAbort({ dataDir: dir, state }, { sessionId: 's1', scope: 'group' });
    assert.equal(groupHit.ok, true);
    const afterGroup = loadGroupTimeline(dir, 's1');
    assert.equal(afterGroup.events.find(e => e.taskId === 't1').summary, '被用户中止');
    assert.equal(afterGroup.events.find(e => e.taskId === 't2').status, 'completed');
    upsertTaskEvent(afterGroup, 't4', { kind: 'execution', status: 'running', partitionId: 'p1', summary: '再改' });
    upsertTaskEvent(afterGroup, 't5', { kind: 'execution', status: 'waiting', partitionId: 'p2', summary: '等确认' });
    saveGroupTimeline(dir, 's1', afterGroup);
    handleAbort({ dataDir: dir, state }, { sessionId: 's1', partitionId: 'p1' });
    const afterPart = loadGroupTimeline(dir, 's1');
    assert.equal(afterPart.events.find(e => e.taskId === 't4').summary, '被用户中止');
    assert.equal(afterPart.events.find(e => e.taskId === 't5').status, 'waiting');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
