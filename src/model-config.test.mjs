import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeModelConfig,
  normalizeConnectionModelConfigs,
  normalizeReasoningLevels,
  defaultOutsideCatalog,
  usesModelCatalog,
  resolveRequestModel,
  resolveChatModel,
  connectionModelChoices,
  preferredConnectionModel,
  managerSelectionView,
} from '../public/model-selection.js';
import {modelConfigFields, catalogRow} from '../public/model-config-ui.js';
import {extractModelSummary, renderOfficialCard} from '../public/provider-card.js';

test('努力程度按规范档位升序去重，未知值拒绝', () => {
  assert.deepEqual(normalizeReasoningLevels(['high', 'none', 'high', 'low']), ['none', 'low', 'high']);
  assert.throws(() => normalizeReasoningLevels(['turbo']), /努力程度无效/);
  assert.equal(usesModelCatalog('gemini'), true);
  assert.equal(usesModelCatalog('claude'), false);
});

test('模型配置归一化保留默认模型、努力程度、上下文和列表行', () => {
  const saved = normalizeModelConfig('codex', {
    defaultModel: ' gpt-5.4 ',
    defaultEffort: 'High',
    contextWindow: '272000',
    catalog: [
      { model: 'gpt-5.4', displayName: 'GPT-5.4', contextWindow: 272000, reasoningLevels: ['xhigh', 'low', 'low'], defaultReasoningLevel: 'low', extra: 'drop' },
      { model: '', displayName: 'skip' },
    ],
  });
  assert.deepEqual(saved, {
    defaultModel: 'gpt-5.4',
    defaultEffort: 'high',
    contextWindow: 272000,
    catalog: [{
      model: 'gpt-5.4',
      displayName: 'GPT-5.4',
      contextWindow: 272000,
      reasoningLevels: ['low', 'xhigh'],
      defaultReasoningLevel: 'low',
    }],
  });
  assert.equal(saved.catalog[0].extra, undefined);
  assert.deepEqual(normalizeModelConfig('gemini', { defaultModel: 'gemini-2.5-pro', catalog: [{ model: 'gemini-2.5-pro' }] }).catalog[0], { model: 'gemini-2.5-pro', displayName: '' });
  const grouped = normalizeModelConfig('gemini', {
    catalog: [{
      model: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      reasoningLevels: ['low', 'medium', 'high'],
      defaultReasoningLevel: 'medium',
      effortModels: { low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high', junk: 'x' },
    }],
  });
  assert.deepEqual(grouped.catalog[0].effortModels, {
    low: 'gemini-3.8-flash-low',
    medium: 'gemini-3.8-flash-medium',
    high: 'gemini-3.8-flash-high',
  });
  const claude = normalizeModelConfig('claude', { env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5' }, defaultEffort: 'max' });
  assert.equal(claude.env.ANTHROPIC_MODEL, 'claude-sonnet-4-5');
  assert.equal(claude.defaultEffort, 'max');
  assert.equal(claude.catalog, undefined);
  assert.equal(defaultOutsideCatalog({ defaultModel: 'other', catalog: [{ model: 'gpt-5.4', displayName: '' }] }), true);
  assert.throws(() => normalizeModelConfig('codex', { defaultEffort: 'super' }), /努力程度无效/);
  assert.throws(() => normalizeModelConfig('codex', { contextWindow: -1 }), /上下文大小无效/);
});

test('连接级模型配置只保留有效分组', () => {
  const out = normalizeConnectionModelConfigs({
    codex: { defaultModel: 'gpt-4o' },
    fake: { defaultModel: 'nope' },
  }, ['codex']);
  assert.deepEqual(Object.keys(out), ['codex']);
  assert.equal(out.codex.defaultModel, 'gpt-4o');
});

test('官方与自定义配置对话框都提供拉取模型和连通检测', async () => {
  const source = fs.readFileSync(new URL('../public/provider-modal.js', import.meta.url), 'utf8');
  const fields = fs.readFileSync(new URL('../public/model-config-ui.js', import.meta.url), 'utf8');
  const toolbar = fields.slice(fields.indexOf('catalog-toolbar-actions'), fields.indexOf('model-map-head'));
  assert.match(source, /正在从官方账号拉取模型列表/);
  assert.match(source, /from '\.\/toast\.js'/);
  assert.doesNotMatch(source, /cc-test-feedback/);
  assert.match(toolbar, /data-dialog-action="fetch-models"/);
  assert.match(toolbar, /data-dialog-action="test"/);
  assert.match(toolbar, /发送测试/);
  assert.match(toolbar, /data-action="add-model-row"/);
  assert.ok(toolbar.indexOf('发送测试') < toolbar.indexOf('拉取模型'));
  assert.ok(toolbar.indexOf('拉取模型') < toolbar.indexOf('添加模型'));
  assert.doesNotMatch(source, /cc-footer-left/);
  assert.match(source, /form\.querySelector\('\[name=baseUrl\]'\)\?\.value\.trim\(\)/);
  assert.match(source, /applyFetchedCatalog/);
  assert.doesNotMatch(source, /if \(!used\.has\(id\)\) merged\.push/);
  assert.doesNotMatch(source, /rows\.innerHTML = fetched/);
  assert.doesNotMatch(source, /defaultInput\.value = preferred/);
  assert.match(source, /请自行添加到列表/);
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /resolveRequestModel/);
  assert.match(app, /api\('test',\{id:data\.id,model,effort:config\.defaultEffort\|\|'',sessionId:selectedSession\|\|undefined\}\)/);
  assert.match(app, /state\.official\.find\(x=>x\.id===id\)/);
  assert.match(app, /api\('test',\{id,model,effort:cfg\.defaultEffort\|\|'',sessionId:selectedSession\|\|undefined\}\)/);
  assert.match(app, /renderOfficialCard\(c,activeModelGroup,c\.id===activeProviderId,speedResults\.get\(c\.id\)\)/);
  assert.match(app, /renderProviderCard\(c,activeModelGroup,c\.id===activeProviderId,speedResults\.get\(c\.id\)\)/);
  assert.match(app, /\.\.\.rawOfficial\.map[\s\S]*\.\.\.rawConnections\.map/);
  assert.doesNotMatch(app, /renderCard=settingsTab==='official'/);
  assert.doesNotMatch(app, /cc-section-title/);
  assert.match(app, /from '\.\/toast\.js'/);
  const toast = fs.readFileSync(new URL('../public/toast.js', import.meta.url), 'utf8');
  assert.match(toast, /export function notice/);
  assert.match(toast, /showPopover/);
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="notice"/);
  assert.match(html, /popover="manual"/);
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /#notice:popover-open/);
  assert.match(css, /top:\s*20px/);
  assert.match(css, /right:\s*20px/);
  assert.doesNotMatch(css, /bottom:25px;left:50%/);
  assert.doesNotMatch(css, /\.cc-test-feedback/);
  const { inferToastKind } = await import('../public/toast.js');
  assert.equal(inferToastKind('正在向模型发送 hi…', 'info'), 'info');
  assert.equal(inferToastKind('✕ 拉取失败：timeout'), 'error');
  assert.equal(inferToastKind('✓ 已拉取 3 个模型，请自行添加到列表'), 'success');
  assert.equal(inferToastKind('请先保存自定义供应商或完成官方登录'), 'warning');
});

test('连通检测按默认努力程度解析 Gemini 分组请求标识', () => {
  assert.equal(resolveRequestModel({
    defaultModel: 'gemini-3.8-flash',
    defaultEffort: 'medium',
    catalog: [{
      model: 'gemini-3.8-flash',
      effortModels: { low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high' },
    }],
  }), 'gemini-3.8-flash-medium');
  assert.equal(resolveRequestModel({ defaultModel: 'gpt-5.4', catalog: [{ model: 'gpt-5.4' }] }), 'gpt-5.4');
  assert.equal(resolveRequestModel({ env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5' } }), 'claude-sonnet-4-5');
  assert.equal(resolveRequestModel({ catalog: [{ model: 'grok-3' }] }), 'grok-3');
  assert.equal(resolveRequestModel({}), '');
});

test('对话请求模型使用已配置目录和默认努力程度', () => {
  const gemini = {
    id: 'official-gemini',
    modelConfigs: {
      gemini: {
        defaultModel: 'gemini-3.8-flash',
        defaultEffort: 'high',
        catalog: [{
          model: 'gemini-3.8-flash',
          displayName: 'Gemini 3.8 Flash',
          effortModels: { low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high' },
        }, { model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }],
      },
    },
  };
  assert.deepEqual(resolveChatModel(gemini, 'gemini-3.8-flash'), { model: 'gemini-3.8-flash-high', effort: 'high', group: 'gemini' });
  assert.deepEqual(resolveChatModel(gemini, 'gemini-3.8-flash', { effort: 'low' }), { model: 'gemini-3.8-flash-low', effort: 'low', group: 'gemini' });
  assert.deepEqual(resolveChatModel(gemini, 'gemini-3.8-flash', { effort: '' }), { model: 'gemini-3.8-flash', effort: '', group: 'gemini' });
  assert.equal(resolveChatModel(gemini, 'gemini-3.8-flash-medium').model, 'gemini-3.8-flash-medium');
  assert.equal(resolveChatModel(gemini, 'gemini-2.5-pro').model, 'gemini-2.5-pro');
  const grokView=managerSelectionView({
    id:'official-grok',
    modelConfigs:{grok:{defaultModel:'grok-4.6',defaultEffort:'xhigh',contextWindow:131072,catalog:[{model:'grok-4.6',displayName:'Grok 4.6',contextWindow:131072,reasoningLevels:['high','xhigh'],defaultReasoningLevel:'xhigh'}]}},
  },'grok',{connectionId:'official-grok',model:'grok-4.6',effort:'high',contextWindow:64000});
  assert.equal(grokView.model,'grok-4.6');
  assert.equal(grokView.effort,'high');
  assert.equal(grokView.contextWindow,64000);
  assert.deepEqual(grokView.levels,['high','xhigh']);
  assert.equal(preferredConnectionModel(gemini, 'gemini'), 'gemini-3.8-flash');
  assert.deepEqual(connectionModelChoices(gemini, 'gemini').map(m => m.id), ['gemini-3.8-flash', 'gemini-2.5-pro']);
  assert.equal(connectionModelChoices(gemini, 'claude').length, 0);
  const custom = { id: 'c1', models: ['model-a'], modelConfigs: { codex: { defaultModel: 'gpt-5.4' } } };
  assert.ok(connectionModelChoices(custom).some(m => m.id === 'gpt-5.4'));
  assert.ok(connectionModelChoices(custom).some(m => m.id === 'model-a'));
  assert.equal(preferredConnectionModel(custom), 'gpt-5.4');
});

test('表单包含默认模型、默认努力程度、上下文大小和模型列表', () => {
  const html = modelConfigFields({
    modelConfigs: {
      codex: {
        defaultModel: 'gpt-4o',
        defaultEffort: 'medium',
        contextWindow: 128000,
        catalog: [{ model: 'gpt-4o', displayName: 'GPT-4o', contextWindow: 128000, reasoningLevels: ['low', 'high'], defaultReasoningLevel: 'high' }],
      },
    },
  }, 'codex');
  assert.match(html, /默认模型/);
  assert.match(html, /默认努力程度/);
  assert.match(html, /上下文大小/);
  assert.match(html, /模型列表/);
  assert.match(html, /思考等级/);
  assert.match(html, /name="defaultEffort"/);
  assert.match(html, /value="medium" selected/);
  assert.match(html, /data-map-context/);
  assert.match(html, /data-action="add-model-row"/);
  assert.match(html, /发送测试/);
  assert.match(html, /拉取模型/);
  assert.ok(html.indexOf('发送测试') < html.indexOf('添加模型'));
  const gemini = modelConfigFields({ modelConfigs: { gemini: { defaultModel: 'gemini-2.5-pro' } } }, 'gemini');
  assert.match(gemini, /模型列表/);
  const claude = modelConfigFields({ modelConfigs: { claude: { env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5' }, defaultEffort: 'high' } } }, 'claude');
  assert.match(claude, /默认努力程度/);
  assert.match(claude, /1M 上下文/);
  assert.match(claude, /发送测试/);
  assert.match(claude, /拉取模型/);
  assert.doesNotMatch(claude, /模型列表/);
  const row = catalogRow({ model: 'gpt-4o', displayName: 'GPT-4o', contextWindow: 128000, reasoningLevels: ['high'], defaultReasoningLevel: 'high' });
  assert.match(row, /data-map-level[^>]*value="high"[^>]*checked/);
  assert.match(row, /data-action="remove-model-row"/);
  const groupedRow = catalogRow({
    model: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    reasoningLevels: ['low', 'high'],
    effortModels: { low: 'gemini-3.8-flash-low', high: 'gemini-3.8-flash-high' },
  });
  assert.match(groupedRow, /data-effort-models="/);
});

test('卡片摘要展示默认模型、努力程度、上下文和列表数量', () => {
  const summary = extractModelSummary({
    modelConfigs: {
      grok: {
        defaultModel: 'grok-3',
        defaultEffort: 'high',
        contextWindow: 131072,
        catalog: [{ model: 'grok-3' }, { model: 'grok-3-mini' }],
      },
    },
  }, 'grok');
  assert.match(summary, /默认: grok-3/);
  assert.match(summary, /努力: high/);
  assert.match(summary, /上下文 131072/);
  assert.match(summary, /2 个模型/);
  const official = renderOfficialCard({ id: 'official-codex', name: 'Codex', connected: true, expired: false, loginAvailable: true, modelConfigs: { codex: { defaultModel: 'gpt-5.4' } } }, 'codex', false);
  assert.match(official, /默认: gpt-5.4/);
  assert.match(official, /aria-label="配置模型"/);
  assert.match(official, /data-action="test-provider"/);
});

test('自定义与官方模型配置经接口归一化后持久化', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-model-config-'));
  const env = { ...process.env, PORT: '0', AGENTS_DESKTOP: '1', AGENTS_DATA_DIR: dir, MULTI_AGENT_SECRETS: path.join(dir, 'secrets') };
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ projects: [], connections: [] }));
  let child;
  try {
    child = spawn(process.execPath, ['src/server.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const [data] = await once(child.stdout, 'data');
    const address = data.toString().trim().replace('AGENTS_READY ', '');
    const post = (body) => fetch(address + '/api/connection', { method: 'POST', headers: { Origin: address, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const saved = await post({
      name: 'Codex 中转',
      protocol: 'openai',
      baseUrl: 'https://example.com/v1',
      modelGroups: ['codex'],
      modelConfigs: {
        codex: {
          defaultModel: 'gpt-5.4',
          defaultEffort: 'xhigh',
          contextWindow: '272000',
          catalog: [{ model: 'gpt-5.4', displayName: 'GPT-5.4', contextWindow: '272000', reasoningLevels: ['high', 'xhigh'], defaultReasoningLevel: 'xhigh', junk: true }],
        },
      },
    });
    assert.equal(saved.status, 200);
    const custom = (await saved.json()).connections[0].modelConfigs.codex;
    assert.equal(custom.defaultModel, 'gpt-5.4');
    assert.equal(custom.defaultEffort, 'xhigh');
    assert.equal(custom.contextWindow, 272000);
    assert.deepEqual(custom.catalog[0].reasoningLevels, ['high', 'xhigh']);
    assert.equal(custom.catalog[0].junk, undefined);

    const bad = await post({
      name: 'bad',
      protocol: 'openai',
      baseUrl: 'https://example.com/v1',
      modelGroups: ['codex'],
      modelConfigs: { codex: { defaultEffort: 'nope' } },
    });
    assert.equal(bad.status, 400);

    const official = await post({
      id: 'official-codex',
      modelConfigs: {
        codex: {
          defaultModel: 'gpt-5.4',
          defaultEffort: 'high',
          contextWindow: 272000,
          catalog: [{ model: 'gpt-5.4', displayName: 'GPT-5.4', contextWindow: 272000, reasoningLevels: ['none', 'high'] }],
        },
      },
    });
    assert.equal(official.status, 200);
    const state = await official.json();
    assert.equal(state.officialModelConfigs, undefined);
    const card = state.official.find(c => c.id === 'official-codex');
    assert.equal(card.modelConfigs.codex.defaultModel, 'gpt-5.4');
    assert.equal(card.modelConfigs.codex.defaultEffort, 'high');
    assert.equal(card.modelConfigs.codex.contextWindow, 272000);
    assert.equal(card.modelConfigs.codex.catalog[0].model, 'gpt-5.4');
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
    assert.equal(disk.officialModelConfigs['official-codex'].codex.defaultEffort, 'high');
    assert.equal(JSON.stringify(state).includes('officialModelConfigs'), false);
  } finally {
    if (child?.exitCode === null) {
      const done = once(child, 'exit');
      child.stdin.end();
      await done;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
