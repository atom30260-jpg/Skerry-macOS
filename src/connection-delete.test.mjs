import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {saveSecret, hasSecret} from './secret-store.mjs';

test('删除供应商连接同步销毁密钥与重置管理者', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-del-test-'));
  const env = {
    ...process.env,
    PORT: '0',
    AGENTS_DESKTOP: '1',
    AGENTS_DATA_DIR: dir,
    MULTI_AGENT_SECRETS: path.join(dir, 'secrets'),
  };

  const seed = {
    projects: [],
    connections: [
      {
        id: 'conn-del',
        name: 'Delete Me',
        provider: '自定义',
        protocol: 'openai',
        baseUrl: 'https://example.com/v1',
        models: ['gpt-4o'],
      },
      {
        id: 'conn-keep',
        name: 'Keep Me',
        provider: '自定义',
        protocol: 'openai',
        baseUrl: 'https://example.com/v1',
        models: ['gpt-4o'],
      },
    ],
    manager: {
      connectionId: 'conn-del',
      model: 'gpt-4o',
    },
  };

  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(seed));
  saveSecret('conn-del', 'secret-del-value', env);
  saveSecret('conn-keep', 'secret-keep-value', env);

  let child;
  async function start() {
    child = spawn(process.execPath, ['src/server.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const [data] = await once(child.stdout, 'data');
    return data.toString().trim().replace('AGENTS_READY ', '');
  }

  async function stop() {
    if (child?.exitCode === null) {
      const done = once(child, 'exit');
      child.stdin.end();
      await done;
    }
  }

  try {
    const address = await start();
    const post = async (endpoint, body) =>
      fetch(address + endpoint, {
        method: 'POST',
        headers: { Origin: address, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // 1. 删除不存在的连接报错
    const errRes = await post('/api/connection/delete', { id: 'not-exist' });
    assert.equal(errRes.status, 400);

    // 2. 删除目标连接
    const okRes = await post('/api/connection/delete', { id: 'conn-del' });
    assert.equal(okRes.status, 200);
    const state = await okRes.json();

    assert.equal(state.connections.some(c => c.id === 'conn-del'), false);
    assert.equal(state.connections.some(c => c.id === 'conn-keep'), true);
    assert.equal(state.manager, null);
    assert.equal(hasSecret('conn-del', env), false);
    assert.equal(hasSecret('conn-keep', env), true);
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('退出官方登录会删除工作台凭证并取消当前使用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-logout-test-'));
  const env = {
    ...process.env,
    PORT: '0',
    AGENTS_DESKTOP: '1',
    AGENTS_DATA_DIR: dir,
    MULTI_AGENT_SECRETS: path.join(dir, 'secrets'),
  };
  const seed = {
    projects: [],
    connections: [],
    manager: { connectionId: 'official-codex', model: 'gpt-5' },
    activeProviders: { codex: 'official-codex' },
  };
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(seed));
  saveSecret('official-codex', JSON.stringify({
    accessToken: 'synthetic-codex-access',
    refreshToken: 'synthetic-codex-refresh',
    expiresAt: Date.now() + 3600_000,
  }), env);

  let child;
  async function start() {
    child = spawn(process.execPath, ['src/server.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const [data] = await once(child.stdout, 'data');
    return data.toString().trim().replace('AGENTS_READY ', '');
  }
  async function stop() {
    if (child?.exitCode === null) {
      const done = once(child, 'exit');
      child.stdin.end();
      await done;
    }
  }

  try {
    const address = await start();
    const before = await (await fetch(address + '/api/state')).json();
    const connected = before.official.find(c => c.id === 'official-codex');
    assert.equal(connected.connected, true);
    const res = await fetch(address + '/api/auth/disconnect', {
      method: 'POST',
      headers: { Origin: address, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'official-codex' }),
    });
    assert.equal(res.status, 200);
    const after = await (await fetch(address + '/api/state')).json();
    const loggedOut = after.official.find(c => c.id === 'official-codex');
    assert.equal(loggedOut.connected, false);
    assert.equal(hasSecret('official-codex', env), false);
    assert.equal(after.manager, null);
    assert.equal(after.activeProviders?.codex, undefined);
    assert.equal(JSON.stringify(after).includes('synthetic-codex-access'), false);
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
