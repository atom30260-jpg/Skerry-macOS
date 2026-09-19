import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DEFAULT_MODE, normalizeMode } from './permissions.mjs';

export function transcriptFile(dataDir, sessionId, targetKey) {
  return path.join(dataDir, 'transcripts', sessionId, `${targetKey}.json`);
}

export function loadTranscript(dataDir, sessionId, targetKey, vendor = 'custom') {
  const file = transcriptFile(dataDir, sessionId, targetKey);
  if (!fs.existsSync(file)) {
    return {
      version: 1,
      vendor,
      mode: DEFAULT_MODE[vendor] || 'default',
      messages: [],
      todos: [],
      plan: '',
      updatedAt: Date.now(),
    };
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.messages = Array.isArray(data.messages) ? data.messages : [];
    data.todos = Array.isArray(data.todos) ? data.todos : [];
    data.mode = normalizeMode(vendor, data.mode);
    data.vendor = vendor;
    return data;
  } catch {
    return { version: 1, vendor, mode: DEFAULT_MODE[vendor] || 'default', messages: [], todos: [], plan: '', updatedAt: Date.now() };
  }
}

export function saveTranscript(dataDir, sessionId, targetKey, transcript) {
  const file = transcriptFile(dataDir, sessionId, targetKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...transcript, updatedAt: Date.now() };
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(file + '.tmp', file);
  return next;
}

export function appendMessage(transcript, message) {
  const entry = {
    id: message.id || crypto.randomUUID(),
    role: message.role,
    content: message.content || '',
    thoughts: message.thoughts || '',
    toolCalls: message.toolCalls || [],
    toolResults: message.toolResults || [],
    model: message.model || '',
    requestModel: message.requestModel || '',
    effort: message.effort || '',
    timestamp: message.timestamp || new Date().toISOString(),
    usage: message.usage || null,
    finishReason: message.finishReason || '',
    kind: message.kind || '',
    name: message.name || '',
    status: message.status || '',
  };
  transcript.messages.push(entry);
  return entry;
}

export function publicTranscript(transcript) {
  return {
    vendor: transcript.vendor,
    mode: transcript.mode,
    todos: transcript.todos || [],
    plan: transcript.plan || '',
    messages: (transcript.messages || []).map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thoughts: m.thoughts,
      toolCalls: m.toolCalls,
      toolResults: m.toolResults,
      model: m.model,
      timestamp: m.timestamp,
      finishReason: m.finishReason,
      kind: m.kind || '',
      name: m.name || '',
      status: m.status || '',
    })),
  };
}

export function groupFile(dataDir, sessionId) {
  return path.join(dataDir, 'transcripts', sessionId, 'group.json');
}

export function loadGroupTimeline(dataDir, sessionId) {
  const file = groupFile(dataDir, sessionId);
  if (!fs.existsSync(file)) return { version: 1, events: [], updatedAt: Date.now() };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.events = Array.isArray(data.events) ? data.events : [];
    data.version = data.version || 1;
    return data;
  } catch {
    return { version: 1, events: [], updatedAt: Date.now() };
  }
}

export function saveGroupTimeline(dataDir, sessionId, timeline) {
  const file = groupFile(dataDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...timeline, updatedAt: Date.now() };
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(file + '.tmp', file);
  return next;
}

export function appendGroupEvent(timeline, event) {
  const entry = {
    id: event.id || crypto.randomUUID(),
    type: event.type,
    content: event.content || '',
    timestamp: event.timestamp || new Date().toISOString(),
    taskId: event.taskId || '',
    kind: event.kind || '',
    status: event.status || '',
    name: event.name || '',
    vendor: event.vendor || '',
    vendorLabel: event.vendorLabel || '',
    model: event.model || '',
    partitionId: event.partitionId || '',
    slot: event.slot || 0,
    summary: event.summary || '',
    source: event.source || '',
  };
  if (!Array.isArray(timeline.events)) timeline.events = [];
  timeline.events.push(entry);
  return entry;
}

export function upsertTaskEvent(timeline, taskId, patch) {
  const id = String(taskId || '');
  let ev = (timeline.events || []).find(e => e.type === 'task' && e.taskId === id);
  if (!ev) {
    ev = appendGroupEvent(timeline, { type: 'task', taskId: id, ...patch });
    return ev;
  }
  Object.assign(ev, patch, { taskId: id, type: 'task' });
  return ev;
}

export function abortTaskEvents(timeline, predicate, summary = '被用户中止') {
  const changed = [];
  for (const ev of timeline.events || []) {
    if (ev.type !== 'task') continue;
    if (ev.status !== 'running' && ev.status !== 'waiting') continue;
    if (predicate && !predicate(ev)) continue;
    Object.assign(ev, { status: 'failed', summary });
    changed.push(ev);
  }
  return changed;
}

export class HitlBus extends EventEmitter {
  constructor({ timeoutMs = 300_000 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  request({ sessionId, targetId, vendor, toolName, args, summary, riskLevel = 'medium', kind = 'ask' }) {
    const id = crypto.randomUUID();
    const approval = {
      id,
      sessionId,
      targetId,
      vendor,
      toolName,
      args,
      summary,
      riskLevel,
      kind,
      createdAt: Date.now(),
      status: 'pending',
    };
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ approved: false, reason: '审批超时' });
        }
      }, this.timeoutMs);
      this.pending.set(id, { approval, resolve, timer });
      this.emit('request', approval);
    });
  }

  resolve(id, { approved, reason = '', answers } = {}) {
    const entry = this.pending.get(id);
    if (!entry) return { ok: false, error: '审批不存在或已处理' };
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.approval.status = approved ? 'approved' : 'rejected';
    entry.resolve({ approved: Boolean(approved), reason, answers });
    return { ok: true };
  }

  cancelSession(sessionId, targetId) {
    for (const [id, entry] of this.pending) {
      if (entry.approval.sessionId !== sessionId) continue;
      if (targetId && entry.approval.targetId !== targetId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ approved: false, reason: '已取消' });
    }
  }

  list(sessionId) {
    return [...this.pending.values()].map(e => e.approval).filter(a => !sessionId || a.sessionId === sessionId);
  }
}
