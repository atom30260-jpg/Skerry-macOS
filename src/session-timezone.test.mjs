import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JAPAN_TIMEZONE,
  US_TIMEZONE,
  SESSION_TIMEZONES,
  applyRequestTimezone,
  applyResponseTimezone,
  convertJsonDatetimes,
  ensureSessionTimezone,
  isSessionTimezone,
  pickSessionTimezone,
} from './session-timezone.mjs';

test('新会话只在日本或美国时区中二选一，选定后保持不变', () => {
  assert.equal(pickSessionTimezone(() => 0), JAPAN_TIMEZONE);
  assert.equal(pickSessionTimezone(() => 0.9), US_TIMEZONE);
  const session = {};
  assert.equal(ensureSessionTimezone(session, () => 0), JAPAN_TIMEZONE);
  assert.equal(session.timezone, JAPAN_TIMEZONE);
  assert.equal(ensureSessionTimezone(session, () => 0.9), JAPAN_TIMEZONE);
  session.timezone = 'Asia/Shanghai';
  assert.equal(ensureSessionTimezone(session, () => 0.9), US_TIMEZONE);
  assert.ok(SESSION_TIMEZONES.every(isSessionTimezone));
  assert.equal(isSessionTimezone('Europe/London'), false);
});

test('请求体日期时间从本地转到会话时区，回包再转回本地', () => {
  const local = 'Asia/Shanghai';
  const outgoing = applyRequestTimezone({
    timezone: 'Asia/Shanghai',
    created: '2026-09-16T15:00:00+08:00',
    naive: '2026-09-16T15:00:00',
    day: '2026-09-16',
    text: 'hi',
    nested: { at: '2026-09-16 15:00:00+08:00' },
  }, JAPAN_TIMEZONE, local);
  assert.equal(outgoing.timezone, 'Asia/Shanghai');
  assert.equal(outgoing.created, '2026-09-16T16:00:00+09:00');
  assert.equal(outgoing.naive, '2026-09-16T16:00:00+09:00');
  assert.equal(outgoing.day, '2026-09-16');
  assert.equal(outgoing.text, 'hi');
  assert.equal(outgoing.nested.at, '2026-09-16T16:00:00+09:00');

  const incoming = applyResponseTimezone({
    created: '2026-09-16T16:00:00+09:00',
    preview: 'hi',
  }, JAPAN_TIMEZONE, local);
  assert.equal(incoming.created, '2026-09-16T15:00:00+08:00');
  assert.equal(incoming.preview, 'hi');
});

test('美国时区跨日切日期，且不改写正文里的日期', () => {
  const converted = convertJsonDatetimes({
    day: '2026-09-16',
    created: '2026-09-16T00:30:00+08:00',
    note: '截止 2026-09-16 开会',
  }, 'Asia/Shanghai', US_TIMEZONE);
  assert.equal(converted.day, '2026-09-15');
  assert.match(converted.created, /^2026-09-15T12:30:00-0[45]:00$/);
  assert.equal(converted.note, '截止 2026-09-16 开会');
  assert.equal(convertJsonDatetimes({ created: '2026-09-16T15:00:00+08:00' }, US_TIMEZONE, US_TIMEZONE).created, '2026-09-16T15:00:00+08:00');
});

test('新建会话写入时区，后续读取保持同一时区', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tz-'));
  const env = { ...process.env, PORT: '0', AGENTS_DESKTOP: '1', AGENTS_DATA_DIR: dir, MULTI_AGENT_SECRETS: path.join(dir, 'secrets') };
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({
    projects: [{ id: 'p', name: 'p', path: dir, sessions: [{ id: 'old', name: '旧会话', partitions: [] }] }],
    connections: [],
  }));
  let child;
  try {
    child = spawn(process.execPath, ['src/server.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const [data] = await once(child.stdout, 'data');
    const address = data.toString().trim().replace('AGENTS_READY ', '');
    const headers = { Origin: address, 'Content-Type': 'application/json' };
    const created = await (await fetch(address + '/api/session', {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: 'p', name: '新会话' }),
    })).json();
    const session = created.projects[0].sessions.at(-1);
    assert.ok(isSessionTimezone(session.timezone), session.timezone);
    const again = await (await fetch(address + '/api/state')).json();
    assert.equal(again.projects[0].sessions.at(-1).timezone, session.timezone);
    const old = again.projects[0].sessions.find(item => item.id === 'old');
    assert.ok(isSessionTimezone(old.timezone), old.timezone);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
    assert.equal(saved.projects[0].sessions.at(-1).timezone, session.timezone);
    assert.ok(isSessionTimezone(saved.projects[0].sessions.find(item => item.id === 'old').timezone));
  } finally {
    if (child?.exitCode === null) {
      const done = once(child, 'exit');
      child.stdin.end();
      await done;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
