import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { renderProviderCard } from '../public/provider-card.js';
import {
  getPresets,
  getOfficialPreset,
  filterPresets,
  sortPresets,
  ICON_FILES,
  PARTNER_PROMOTIONS,
} from '../public/provider-presets.js';
import {
  defaultProtocolForGroup,
  isValidProtocol,
  protocolBadge,
  protocolSelectOptions,
} from '../public/protocols.js';
import { sanitizeEndpointTimeout, testApiEndpoints } from './model-fetch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = ['claude', 'codex', 'gemini', 'grok'];

function startMockApi() {
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.endsWith('/models') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-test', owned_by: 'mock' }] }));
      return;
    }
    if (url.endsWith('/chat/completions') && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'hi back' } }] }));
      return;
    }
    if (url.endsWith('/responses') && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output_text: 'hi responses' }));
      return;
    }
    if (url.endsWith('/messages') && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'hi anthropic' }] }));
      return;
    }
    res.writeHead(204);
    res.end();
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}`, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-custom-'));
  const env = {
    ...process.env,
    PORT: '0',
    AGENTS_DESKTOP: '1',
    AGENTS_DATA_DIR: dir,
    MULTI_AGENT_SECRETS: path.join(dir, 'secrets'),
  };
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ projects: [], connections: [] }));
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

test('工作台三种上游格式为 OpenAI / Anthropic / Responses', () => {
  assert.equal(isValidProtocol('openai'), true);
  assert.equal(isValidProtocol('anthropic'), true);
  assert.equal(isValidProtocol('responses'), true);
  assert.equal(isValidProtocol('gemini'), false);
  assert.equal(isValidProtocol('graphql'), false);
  assert.equal(defaultProtocolForGroup('claude'), 'anthropic');
  assert.equal(defaultProtocolForGroup('codex'), 'responses');
  assert.equal(defaultProtocolForGroup('gemini'), 'openai');
  assert.equal(defaultProtocolForGroup('grok'), 'openai');
  assert.deepEqual(protocolSelectOptions().map(o => o.value), ['openai', 'anthropic', 'responses']);
  assert.equal(protocolBadge('responses'), 'Responses');
  assert.equal(protocolBadge('unknown'), 'OpenAI');
});

test('预设目录覆盖四家系列且不含官方 OAuth 分类', () => {
  const counts = Object.fromEntries(GROUPS.map(group => [group, getPresets(group).length]));
  assert.deepEqual(counts, { claude: 83, codex: 84, gemini: 25, grok: 40 });
  for (const group of GROUPS) {
    const list = getPresets(group);
    assert.ok(list.every(p => p.category !== 'official'));
    assert.ok(list.every(p => p.category !== 'official' && !String(p.baseUrl || '').includes('${')));
    const ids = list.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(list.some(p => p.id === 'custom' && p.category === 'custom' && p.name === '自定义供应商'));
  }
  assert.ok(getOfficialPreset('claude')?.modelConfig?.env?.ANTHROPIC_MODEL);
  assert.ok(getOfficialPreset('codex')?.modelConfig?.catalog?.length);
  assert.ok(getOfficialPreset('gemini')?.modelConfig?.defaultModel);
  assert.ok(getOfficialPreset('grok')?.modelConfig?.defaultModel);
  assert.ok(Object.keys(ICON_FILES).length >= 100);
  assert.ok(fs.existsSync(path.join(root, 'public', 'icons', 'kimi.svg')));
  assert.ok(fs.existsSync(path.join(root, 'public', 'icons', 'a6-icon.png')));
  assert.ok(PARTNER_PROMOTIONS.kimi);
  assert.ok(getPresets('codex').some(p => p.id === 'azure-openai'));
  assert.equal(getPresets('codex').find(p => p.id === 'custom')?.protocol, 'responses');
  assert.equal(getPresets('claude').find(p => p.id === 'custom')?.protocol, 'anthropic');
  assert.equal(getPresets('gemini').find(p => p.id === 'custom')?.protocol, 'openai');
  assert.equal(getPresets('grok').find(p => p.id === 'custom')?.protocol, 'openai');
  assert.ok(getPresets('codex').some(p => p.protocol === 'responses'));
  assert.ok(getPresets('codex').some(p => p.protocol === 'openai'));
  assert.ok(getPresets('grok').some(p => p.protocol === 'responses'));
  for (const group of GROUPS) {
    assert.ok(getPresets(group).every(p => p.protocol !== 'gemini'));
  }
  assert.equal(getOfficialPreset('gemini')?.protocol, 'openai');
});

test('预设排序把自定义芯片置顶，尊享合作伙伴随后，搜索可按名称过滤', () => {
  const claude = getPresets('claude');
  const original = sortPresets(claude, 'original');
  assert.equal(original[0].id, 'custom');
  assert.equal(original.filter(p => p.id === 'custom').length, 1);
  assert.equal(original[1].primePartner, true);
  assert.equal(original[1].id, 'kimi');
  const named = sortPresets(claude, 'nameAsc');
  assert.equal(named[0].id, 'custom');
  const rest = named.slice(1);
  const names = rest.map(p => p.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'zh')));
  const kimi = filterPresets(claude, 'kimi');
  assert.ok(kimi.some(p => p.id === 'kimi'));
  assert.ok(kimi.every(p => /kimi/i.test([p.name, p.baseUrl, p.websiteUrl, p.category].join(' '))));
});

test('添加/编辑表单复刻预设搜索、备注、官网、获取 Key 与端点测速', () => {
  const modal = fs.readFileSync(new URL('../public/provider-modal.js', import.meta.url), 'utf8');
  assert.match(modal, /管理和测速/);
  assert.match(modal, /获取 API Key/);
  assert.match(modal, /name="notes"/);
  assert.match(modal, /name="websiteUrl"/);
  assert.match(modal, /data-preset-search/);
  assert.match(modal, /Ctrl\+F|metaKey/);
  assert.match(modal, /endpointCandidates/);
  assert.match(modal, /customEndpoints/);
  assert.match(modal, /partnerPromotionKey/);
  assert.match(modal, /\/api\/endpoints\/test/);
  assert.match(modal, /自动选择最快/);
  assert.match(modal, /预设供应商/);
  assert.match(modal, /form\.querySelector\('\[name=baseUrl\]'\)\?\.value\.trim\(\)/);
  assert.match(modal, /applyFetchedCatalog/);
  assert.match(modal, /正在从官方账号拉取模型列表/);
  assert.match(modal, /from '\.\/toast\.js'/);
  assert.doesNotMatch(modal, /cc-test-feedback/);
  assert.match(modal, /protocolSelectOptions/);
  assert.match(modal, /PROTOCOL_HINT/);
  assert.match(modal, /defaultProtocolForGroup/);
  assert.doesNotMatch(modal, /<option value="gemini">Gemini 兼容<\/option>/);
  const protocols = fs.readFileSync(new URL('../public/protocols.js', import.meta.url), 'utf8');
  assert.match(protocols, /Responses 兼容/);
  assert.match(protocols, /OpenAI 兼容/);
  assert.match(protocols, /Anthropic 兼容/);
  assert.doesNotMatch(protocols, /Gemini 兼容/);
  assert.match(protocols, /\/chat\/completions/);
  assert.match(protocols, /\/messages/);
  assert.match(protocols, /\/responses/);
  assert.doesNotMatch(modal, /完整 URL/);
  assert.doesNotMatch(modal, /if \(!used\.has\(id\)\) merged\.push/);
  const fields = fs.readFileSync(new URL('../public/model-config-ui.js', import.meta.url), 'utf8');
  const toolbar = fields.slice(fields.indexOf('catalog-toolbar-actions'), fields.indexOf('model-map-head'));
  assert.match(toolbar, /data-dialog-action="fetch-models"/);
  assert.match(toolbar, /data-dialog-action="test"/);
  assert.match(toolbar, /data-action="add-model-row"/);
  assert.doesNotMatch(modal, /cc-footer-left/);
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /if\(!data\.id\)/);
  assert.match(app, /api\('test',\{id:data\.id,model,effort:config\.defaultEffort\|\|'',sessionId:selectedSession\|\|undefined\}\)/);
  assert.match(app, /api\('connection\/copy'/);
  assert.match(app, /已复制供应商/);
  assert.doesNotMatch(app, /openEditModal\(copy\)/);
  assert.doesNotMatch(app, /已创建副本草稿/);
  const desktop = fs.readFileSync(new URL('../scripts/prepare-desktop.mjs', import.meta.url), 'utf8');
  assert.match(desktop, /public['",\\/]+icons|iconsSrc/);
  assert.match(desktop, /protocols\.js/);
});

test('自定义卡片优先展示备注，合作伙伴标记心形/星标，不打自定义提供商分类', () => {
  const notes = renderProviderCard({
    id: 'c1',
    name: 'Kimi',
    notes: '卡片备注',
    websiteUrl: 'https://platform.kimi.com',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    protocol: 'anthropic',
    primePartner: true,
    hasKey: true,
  }, 'claude', true);
  assert.doesNotMatch(notes, /自定义提供商/);
  assert.doesNotMatch(notes, /官方登录/);
  assert.match(notes, /当前使用/);
  assert.match(notes, /卡片备注/);
  assert.match(notes, /partner-heart/);
  assert.doesNotMatch(notes, /platform\.kimi\.com/);
  assert.doesNotMatch(notes, /set-manager/);
  const site = renderProviderCard({
    id: 'c2',
    name: 'Packy',
    websiteUrl: 'https://www.packyapi.ai',
    protocol: 'openai',
    isPartner: true,
    hasKey: false,
  }, 'codex', false);
  assert.match(site, /www\.packyapi\.ai/);
  assert.match(site, /partner-star/);
  assert.match(site, /未存密钥/);
  const responses = renderProviderCard({
    id: 'c3',
    name: 'Codex Relay',
    protocol: 'responses',
    hasKey: true,
  }, 'codex', false);
  assert.match(responses, />Responses</);
  assert.doesNotMatch(responses, />OpenAI</);
});

test('端点测速先预热再计时，空列表合法，超时被夹紧', async () => {
  assert.equal(sanitizeEndpointTimeout(undefined), 8);
  assert.equal(sanitizeEndpointTimeout(0), 2);
  assert.equal(sanitizeEndpointTimeout(100), 30);
  const calls = [];
  const results = await testApiEndpoints(
    ['https://api.example.com/v1', 'https://bad.example/v1?q=1', ''],
    8,
    async (url, opts) => {
      calls.push({ url, method: opts.method, redirect: opts.redirect });
      if (String(url).includes('api.example.com')) {
        return { status: 200, ok: true };
      }
      throw new Error('fetch failed');
    },
  );
  assert.equal(results.length, 3);
  assert.equal(results[0].status, 200);
  assert.equal(typeof results[0].latency, 'number');
  assert.equal(results[1].latency, null);
  assert.match(results[1].error, /查询或片段|模型地址/);
  assert.equal(results[2].error, 'URL 不能为空');
  const warmupAndTimed = calls.filter(c => c.url === 'https://api.example.com/v1');
  assert.equal(warmupAndTimed.length, 2);
  assert.ok(warmupAndTimed.every(c => c.method === 'GET' && c.redirect === 'error'));
  assert.deepEqual(await testApiEndpoints([], 8, async () => ({ status: 200 })), []);
});

test('连接持久化备注官网图标合作伙伴与端点，草稿可拉模型/测连通', async () => {
  const mock = await startMockApi();
  try {
    await withServer(async ({ address, post }) => {
      const saved = await post('/api/connection', {
        name: 'Kimi 中转',
        protocol: 'anthropic',
        baseUrl: 'https://api.moonshot.cn/anthropic',
        modelGroups: ['claude'],
        notes: '卡片备注',
        websiteUrl: 'https://platform.kimi.com?aff=cc-switch',
        apiKeyUrl: 'https://platform.kimi.com?aff=cc-switch',
        icon: 'kimi',
        iconColor: '#6366F1',
        iconFile: 'kimi.svg',
        presetId: 'kimi',
        isPartner: true,
        primePartner: true,
        partnerPromotionKey: 'kimi',
        category: 'cn_official',
        endpointCandidates: ['https://api.moonshot.cn/anthropic', 'https://api.moonshot.ai/anthropic'],
        customEndpoints: ['https://api.example.com/v1'],
        key: 'sk-live',
      });
      assert.equal(saved.status, 200);
      const conn = (await saved.json()).connections[0];
      assert.equal(conn.notes, '卡片备注');
      assert.equal(conn.websiteUrl, 'https://platform.kimi.com?aff=cc-switch');
      assert.equal(conn.icon, 'kimi');
      assert.equal(conn.iconFile, 'kimi.svg');
      assert.equal(conn.primePartner, true);
      assert.equal(conn.isPartner, true);
      assert.equal(conn.partnerPromotionKey, 'kimi');
      assert.deepEqual(conn.endpointCandidates, ['https://api.moonshot.cn/anthropic', 'https://api.moonshot.ai/anthropic']);
      assert.deepEqual(conn.customEndpoints, ['https://api.example.com/v1']);
      assert.equal(conn.hasKey, true);

      const keep = await post('/api/connection', {
        id: conn.id,
        name: 'Kimi 中转',
        protocol: 'anthropic',
        baseUrl: 'https://api.moonshot.cn/anthropic',
        modelGroups: ['claude'],
      });
      assert.equal(keep.status, 200);
      const kept = (await keep.json()).connections[0];
      assert.equal(kept.notes, '卡片备注');
      assert.equal(kept.websiteUrl, 'https://platform.kimi.com?aff=cc-switch');

      const badIcon = await post('/api/connection', {
        name: 'bad icon',
        protocol: 'openai',
        baseUrl: 'https://example.com/v1',
        icon: 'foo/bar',
      });
      assert.equal(badIcon.status, 400);

      const badModelsUrl = await post('/api/connection', {
        name: 'bad models',
        protocol: 'openai',
        baseUrl: 'https://example.com/v1',
        modelsUrl: 'https://example.com/v1/models?x=1',
      });
      assert.equal(badModelsUrl.status, 400);

      const models = await post('/api/models', {
        protocol: 'openai',
        baseUrl: mock.baseUrl,
        key: 'sk-draft',
      });
      assert.equal(models.status, 200);
      assert.deepEqual((await models.json()).models, ['gpt-test']);

      const responsesModels = await post('/api/models', {
        protocol: 'responses',
        baseUrl: mock.baseUrl,
        key: 'sk-draft',
      });
      assert.equal(responsesModels.status, 200);
      assert.deepEqual((await responsesModels.json()).models, ['gpt-test']);

      const ping = await post('/api/test', {
        id: '',
        model: 'gpt-test',
        protocol: 'openai',
        baseUrl: mock.baseUrl,
        key: 'sk-draft',
      });
      assert.equal(ping.status, 200);
      const pingBody = await ping.json();
      assert.equal(pingBody.preview, 'hi back');
      assert.ok(pingBody.durationMs >= 0);

      const responsesPing = await post('/api/test', {
        id: '',
        model: 'gpt-test',
        protocol: 'responses',
        baseUrl: mock.baseUrl,
        key: 'sk-draft',
        effort: 'medium',
      });
      assert.equal(responsesPing.status, 200);
      assert.equal((await responsesPing.json()).preview, 'hi responses');

      const anthropicPing = await post('/api/test', {
        id: '',
        model: 'claude-test',
        protocol: 'anthropic',
        baseUrl: mock.baseUrl,
        key: 'sk-draft',
      });
      assert.equal(anthropicPing.status, 200);
      assert.equal((await anthropicPing.json()).preview, 'hi anthropic');

      const savedResponses = await post('/api/connection', {
        name: 'Responses 中转',
        protocol: 'responses',
        baseUrl: 'https://api.example.com/v1',
        modelGroups: ['codex'],
      });
      assert.equal(savedResponses.status, 200);
      assert.equal((await savedResponses.json()).connections.at(-1).protocol, 'responses');

      const geminiRejected = await post('/api/connection', {
        name: 'Gemini Native leftover',
        protocol: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      });
      assert.equal(geminiRejected.status, 400);

      const missingKey = await post('/api/test', {
        id: '',
        model: 'gpt-test',
        protocol: 'openai',
        baseUrl: mock.baseUrl,
      });
      assert.equal(missingKey.status, 400);

      const endpoints = await post('/api/endpoints/test', {
        urls: [mock.origin, mock.baseUrl],
        timeoutSecs: 8,
      });
      assert.equal(endpoints.status, 200);
      const endpointBody = await endpoints.json();
      assert.equal(endpointBody.results.length, 2);
      assert.equal(endpointBody.results[0].status, 204);
      assert.equal(typeof endpointBody.results[0].latency, 'number');

      const empty = await post('/api/endpoints/test', { urls: [] });
      assert.equal(empty.status, 200);
      assert.deepEqual((await empty.json()).results, []);

      const png = await fetch(address + '/icons/a6-icon.png');
      assert.equal(png.status, 200);
      assert.match(png.headers.get('content-type') || '', /image\/png/);
      assert.match(png.headers.get('content-security-policy') || '', /img-src 'self'/);

      const svg = await fetch(address + '/icons/kimi.svg');
      assert.equal(svg.status, 200);
      assert.match(svg.headers.get('content-type') || '', /image\/svg\+xml/);
    });
  } finally {
    mock.server.close();
  }
});

test('复制供应商立刻插在原卡片下方并带上密钥', async () => {
  await withServer(async ({ post, dir }) => {
    const first = await post('/api/connection', {
      name: 'Codex测试1',
      protocol: 'responses',
      baseUrl: 'https://api.example.com/v1',
      modelGroups: ['codex'],
      notes: '源卡片备注',
      websiteUrl: 'https://api.example.com',
      icon: 'openai',
      iconFile: 'openai.svg',
      presetId: 'custom',
      category: 'custom',
      endpointCandidates: ['https://api.example.com/v1'],
      customEndpoints: ['https://api.example.net/v1'],
      modelConfigs: {
        codex: {
          defaultModel: 'gpt-5.6-terra',
          defaultEffort: 'medium',
          contextWindow: 272000,
          catalog: [{
            model: 'gpt-5.6-terra',
            displayName: 'GPT-5.6 Terra',
            reasoningLevels: ['low', 'medium', 'high'],
            defaultReasoningLevel: 'medium',
          }],
        },
      },
      key: 'sk-copy-src',
    });
    assert.equal(first.status, 200);
    const source = (await first.json()).connections[0];

    const other = await post('/api/connection', {
      name: 'Other',
      protocol: 'openai',
      baseUrl: 'https://example.com/v1',
      modelGroups: ['codex'],
    });
    assert.equal(other.status, 200);
    assert.deepEqual((await other.json()).connections.map(c => c.name), ['Codex测试1', 'Other']);

    const copied = await post('/api/connection/copy', { id: source.id });
    assert.equal(copied.status, 200);
    const list = (await copied.json()).connections;
    assert.equal(list.length, 3);
    assert.equal(list[0].id, source.id);
    assert.equal(list[1].name, 'Codex测试1 (copy)');
    assert.notEqual(list[1].id, source.id);
    assert.equal(list[1].hasKey, true);
    assert.equal(list[2].name, 'Other');
    const {id: _sid, name: _sname, hasKey: _skey, ...sourceFields} = source;
    const {id: _cid, name: _cname, hasKey: _ckey, ...copyFields} = list[1];
    assert.deepEqual(copyFields, sourceFields);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8')).connections[1].id, list[1].id);

    const again = await post('/api/connection/copy', { id: source.id });
    assert.equal(again.status, 200);
    assert.deepEqual((await again.json()).connections.map(c => c.name), [
      'Codex测试1',
      'Codex测试1 (copy 2)',
      'Codex测试1 (copy)',
      'Other',
    ]);

    const official = await post('/api/connection/copy', { id: 'official-codex' });
    assert.equal(official.status, 400);
    assert.match((await official.json()).error, /官方登录不可复制/);

    const missing = await post('/api/connection/copy', { id: 'nope' });
    assert.equal(missing.status, 400);
  });
});

test('已存 Gemini Native 连接启动时改成 OpenAI 兼容', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-gemini-migrate-'));
  const env = {
    ...process.env,
    PORT: '0',
    AGENTS_DESKTOP: '1',
    AGENTS_DATA_DIR: dir,
    MULTI_AGENT_SECRETS: path.join(dir, 'secrets'),
  };
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({
    projects: [],
    connections: [{
      id: 'old-gemini',
      name: '旧 Gemini',
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    }],
  }));
  const child = spawn(process.execPath, ['src/server.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const [data] = await once(child.stdout, 'data');
    const address = data.toString().trim().replace('AGENTS_READY ', '');
    const res = await fetch(address + '/api/state', { headers: { Origin: address } });
    assert.equal(res.status, 200);
    const conn = (await res.json()).connections.find(c => c.id === 'old-gemini');
    assert.equal(conn.protocol, 'openai');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
    assert.equal(saved.connections[0].protocol, 'openai');
  } finally {
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      child.stdin.end();
      await done;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
