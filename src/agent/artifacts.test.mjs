import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { toolKind, toolPaths, collectArtifactsFromMessages, collectSessionArtifacts } from './artifacts.mjs';
import { previewWorkspaceFile } from './workspace-io.mjs';

test('toolKind 区分写入和来源', () => {
  assert.equal(toolKind('Write'), 'output');
  assert.equal(toolKind('write_to_file'), 'output');
  assert.equal(toolKind('apply_patch'), 'output');
  assert.equal(toolKind('Read'), 'source');
  assert.equal(toolKind('read_file'), 'source');
  assert.equal(toolKind('view_file'), 'source');
  assert.equal(toolKind('run_terminal_command'), '');
});

test('toolPaths 从常见字段和 apply_patch 抽出路径', () => {
  assert.deepEqual(toolPaths('Read', { path: 'a.md' }), ['a.md']);
  assert.deepEqual(toolPaths('Write', { file_path: 'b.js' }), ['b.js']);
  const patch = '*** Add File: src/new.js\n+ok\n*** Update File: src/old.js\n';
  assert.deepEqual(toolPaths('apply_patch', { patch }), ['src/new.js', 'src/old.js']);
});

test('collectArtifactsFromMessages 去重并分类', () => {
  const result = collectArtifactsFromMessages([
    { toolCalls: [
      { name: 'Write', args: { path: 'out.md' } },
      { name: 'write', args: { path: 'out.md' } },
      { name: 'Read', args: { path: 'src/a.js' } },
    ] },
  ]);
  assert.deepEqual(result.outputs.map(item => item.path), ['out.md']);
  assert.deepEqual(result.sources.map(item => item.path), ['src/a.js']);
});

test('collectSessionArtifacts 扫描分区 transcript，跳过 group.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-art-'));
  try {
    const sessionDir = path.join(dir, 'transcripts', 's1');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'group.json'), JSON.stringify({
      messages: [{ toolCalls: [{ name: 'Write', args: { path: 'from-group.md' } }] }],
    }));
    fs.writeFileSync(path.join(sessionDir, 'manager.json'), JSON.stringify({
      messages: [{ toolCalls: [
        { name: 'Read', args: { path: 'src/a.js' } },
        { name: 'search_replace', args: { path: 'src/a.js' } },
      ] }],
    }));
    const got = collectSessionArtifacts(dir, 's1');
    assert.deepEqual(got.outputs.map(item => item.name), ['a.js']);
    assert.deepEqual(got.sources.map(item => item.name), ['a.js']);
    assert.ok(!got.outputs.some(item => String(item.path).includes('from-group')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('previewWorkspaceFile 沙箱、目录、过大、二进制', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-prev-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'hello');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'n.txt'), 'n');
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(512 * 1024 + 1));
    const file = previewWorkspaceFile(dir, 'ok.txt');
    assert.equal(file.ok, true);
    assert.equal(file.kind, 'file');
    assert.equal(file.content, 'hello');
    assert.equal(file.relative, 'ok.txt');
    const folder = previewWorkspaceFile(dir, 'sub');
    assert.equal(folder.kind, 'directory');
    assert.equal(folder.relative, 'sub');
    assert.equal(previewWorkspaceFile(dir, path.join('sub', 'n.txt')).relative, 'sub/n.txt');
    assert.ok(folder.entries.some(entry => entry.name === 'n.txt'));
    assert.equal(previewWorkspaceFile(dir, 'big.txt').kind, 'too_large');
    assert.equal(previewWorkspaceFile(dir, 'bin.dat').kind, 'binary');
    assert.throws(() => previewWorkspaceFile(dir, '../secret'), /超出工作区/);
    assert.throws(() => previewWorkspaceFile(dir, ''), /缺少路径/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function withServer(seed, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ws-'));
  const env = {
    ...process.env,
    PORT: '0',
    AGENTS_DESKTOP: '1',
    AGENTS_DATA_DIR: dir,
    MULTI_AGENT_SECRETS: path.join(dir, 'secrets'),
  };
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(seed));
  const child = spawn(process.execPath, ['src/server.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const [data] = await once(child.stdout, 'data');
    const address = data.toString().trim().replace('AGENTS_READY ', '');
    const post = (endpoint, body) => fetch(address + endpoint, {
      method: 'POST',
      headers: { Origin: address, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await fn({ address, post, dir });
  } finally {
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      child.stdin.end();
      await done;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('会话重命名、摘要和文件预览 API 限制在项目路径内', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-proj-ws-'));
  try {
    fs.writeFileSync(path.join(folder, 'readme.md'), '# hi\n');
    fs.mkdirSync(path.join(folder, 'src'));
    fs.writeFileSync(path.join(folder, 'src', 'a.js'), 'export default 1;\n');
    fs.writeFileSync(path.join(folder, 'bin.dat'), Buffer.from([0, 1, 0]));
    await withServer({
      projects: [{
        id: 'p1',
        name: 'demo',
        path: folder,
        sessions: [{ id: 's1', name: '项目分析', partitions: [{ id: 'm1', name: '管理者AI', role: 'manager', routes: [] }] }],
      }],
      connections: [],
    }, async ({ address, post, dir }) => {
      const sessionDir = path.join(dir, 'transcripts', 's1');
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'group.json'), JSON.stringify({
        messages: [{ toolCalls: [{ name: 'Write', args: { path: 'ignored.md' } }] }],
      }));
      fs.writeFileSync(path.join(sessionDir, 'm1.json'), JSON.stringify({
        messages: [{ toolCalls: [
          { name: 'Read', args: { path: 'readme.md' } },
          { name: 'Write', args: { path: 'src/a.js' } },
        ] }],
      }));
      const renamed = await (await post('/api/session/rename', { id: 's1', name: '新名称' })).json();
      assert.equal(renamed.projects[0].sessions[0].name, '新名称');
      const blank = await post('/api/session/rename', { id: 's1', name: '  ' });
      assert.equal(blank.status, 400);
      const artifacts = await (await post('/api/session/artifacts', { sessionId: 's1' })).json();
      assert.deepEqual(artifacts.outputs.map(item => item.name).sort(), ['a.js']);
      assert.deepEqual(artifacts.sources.map(item => item.name).sort(), ['readme.md']);
      const file = await (await post('/api/workspace/file', { sessionId: 's1', path: 'readme.md' })).json();
      assert.equal(file.ok, true);
      assert.equal(file.kind, 'file');
      assert.match(file.content, /# hi/);
      const listed = await (await post('/api/workspace/list', { sessionId: 's1', path: '.' })).json();
      assert.equal(listed.relative, '.');
      assert.equal(listed.parent, '');
      assert.ok(listed.entries.some(entry => entry.name === 'src' && entry.type === 'directory'));
      const nested = await (await post('/api/workspace/list', { sessionId: 's1', path: 'src' })).json();
      assert.equal(nested.parent, '.');
      assert.ok(nested.entries.some(entry => entry.relative.replace(/\\/g, '/') === 'src/a.js'));
      const binary = await (await post('/api/workspace/file', { sessionId: 's1', path: 'bin.dat' })).json();
      assert.equal(binary.kind, 'binary');
      const escaped = await post('/api/workspace/file', { sessionId: 's1', path: '../secret.txt' });
      assert.equal(escaped.status, 400);
      const listedEscape = await post('/api/workspace/list', { sessionId: 's1', path: '..' });
      assert.equal(listedEscape.status, 400);
      const missing = await post('/api/workspace/file', { sessionId: 's1', path: 'nope.md' });
      assert.equal(missing.status, 400);
      const forbidden = await fetch(address + '/api/workspace/file', { method: 'GET' });
      assert.equal(forbidden.status, 403);
    });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
