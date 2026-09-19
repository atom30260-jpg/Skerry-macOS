import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cc = path.join(root, '参考', 'cc-switch');
const configDir = path.join(cc, 'src', 'config');
const iconDir = path.join(cc, 'src', 'icons', 'extracted');
const outIcons = path.join(root, 'public', 'icons');
const NAME_KEYS = {
  shengsuanyun: '胜算云',
  qiniu: '七牛云',
  doubaoseed: '火山 豆包AI',
  ucloud: '优云智算',
  ucloudCoding: '优云智算Coding Plan',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  together: 'Together AI',
};
const SKIP_PROVIDER_TYPES = new Set(['github_copilot', 'codex_oauth', 'xai_oauth']);
const RASTER_COPY = {
  a6api: 'a6-icon.png',
  apikeyfun: 'apikeyfun.png',
  apinebula: 'apinebula_icon.png',
  atlascloud: 'atlascloud_icon.png',
  claudeapi: 'ClaudeApi.png',
  byteplus: 'byteplus.png',
  ccsub: 'ccsub.svg',
  claudecn: 'claudecn.png',
  cherryin: 'cherryin.png',
  code0: 'code0.png',
  eflowcode: 'eflowcode.png',
  etok: 'etok.png',
  fenno: 'fenno-icon.webp',
  huoshan: 'huoshan.png',
  pateway: 'pateway.jpg',
  pipellm: 'pipellm.png',
  qiniu: 'qiniu.png',
  relaxcode: 'relaxcode.png',
  runapi: 'runapi.jpg',
  shengsuanyun: 'shengsuanyun.svg',
  subrouter: 'subrouter.svg',
  sudocode: 'sudocode.png',
  'sudocode-us': 'sudocode-us.png',
  teamorouter: 'TeamoRouter-icon-dark.png',
  xycai: 'xycai-icon.png',
  zetaapi: 'zetaapi-icon.png',
  hermes: 'hermes.png',
  nekocode: 'nekocode-icon.png',
  unity2: 'unity2.png',
};
const OFFICIAL_DEFAULTS = {
  claude: {
    id: 'anthropic-official',
    name: 'Anthropic 官方',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    modelConfig: {
      defaultEffort: 'high',
      env: {
        ANTHROPIC_MODEL: 'claude-3-7-sonnet-20250219',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-3-7-sonnet-20250219',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-5-haiku-20241022',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-3-opus-20240229',
      },
    },
  },
  codex: {
    id: 'openai-official',
    name: 'OpenAI 官方',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    modelConfig: {
      defaultModel: 'gpt-4o',
      defaultEffort: 'medium',
      contextWindow: 128000,
      catalog: [
        { model: 'gpt-4o', displayName: 'GPT-4o', contextWindow: 128000, reasoningLevels: ['none', 'low', 'medium', 'high'], defaultReasoningLevel: 'medium' },
        { model: 'o1', displayName: 'o1', contextWindow: 200000, reasoningLevels: ['low', 'medium', 'high'], defaultReasoningLevel: 'medium' },
        { model: 'o3-mini', displayName: 'o3-mini', contextWindow: 200000, reasoningLevels: ['low', 'medium', 'high'], defaultReasoningLevel: 'medium' },
      ],
    },
  },
  gemini: {
    id: 'google-official',
    name: 'Google 官方',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    modelConfig: {
      defaultModel: 'gemini-2.5-pro',
      defaultEffort: 'high',
      contextWindow: 1048576,
      catalog: [
        { model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', contextWindow: 1048576, reasoningLevels: ['none', 'low', 'high'], defaultReasoningLevel: 'high' },
        { model: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', contextWindow: 1048576, reasoningLevels: ['none', 'low', 'high'] },
      ],
    },
  },
  grok: {
    id: 'xai-official',
    name: 'xAI 官方',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    modelConfig: {
      defaultModel: 'grok-3',
      defaultEffort: 'high',
      contextWindow: 131072,
      catalog: [
        { model: 'grok-3', displayName: 'Grok 3', contextWindow: 131072, reasoningLevels: ['none', 'low', 'high'], defaultReasoningLevel: 'high' },
        { model: 'grok-3-mini', displayName: 'Grok 3 Mini', contextWindow: 131072, reasoningLevels: ['none', 'low'] },
      ],
    },
  },
};

function splitTopObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let quote = '';
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; quote = ch; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function decodeStr(raw) {
  try { return JSON.parse(`"${raw}"`); } catch { return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
}

function strField(obj, name) {
  const re = new RegExp(`${name}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
  const m = obj.match(re);
  return m ? decodeStr(m[1]) : '';
}

function boolField(obj, name) {
  const re = new RegExp(`${name}\\s*:\\s*(true|false)`);
  const m = obj.match(re);
  return m ? m[1] === 'true' : false;
}

function strArray(obj, name) {
  const re = new RegExp(`${name}\\s*:\\s*\\[([\\s\\S]*?)\\]`);
  const m = obj.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/"((?:\\\\.|[^"\\\\])*)"/g)].map(x => decodeStr(x[1]));
}

function envMap(obj) {
  const env = {};
  const block = obj.match(/env\s*:\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) return env;
  for (const m of block[1].matchAll(/([A-Z0-9_]+)\s*:\s*"((?:\\\\.|[^"\\\\])*)"/g)) {
    env[m[1]] = decodeStr(m[2]);
  }
  return env;
}

function callArgs(obj, fn) {
  const re = new RegExp(`${fn}\\(\\s*([\\s\\S]*?)\\)`);
  const m = obj.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/"((?:\\\\.|[^"\\\\])*)"/g)].map(x => decodeStr(x[1]));
}

function tomlField(obj, name) {
  const re = new RegExp(`${name}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`);
  const m = obj.match(re);
  return m ? decodeStr(m[1]) : '';
}

function slug(name) {
  return String(name || 'custom')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '') || 'custom';
}

function displayName(obj) {
  const key = strField(obj, 'nameKey');
  const short = key.split('.').pop();
  if (short && NAME_KEYS[short]) return NAME_KEYS[short];
  return strField(obj, 'name');
}

function skipObject(obj) {
  if (boolField(obj, 'hidden') || boolField(obj, 'requiresOAuth')) return true;
  if (SKIP_PROVIDER_TYPES.has(strField(obj, 'providerType'))) return true;
  if (strField(obj, 'category') === 'official') return true;
  if (strField(obj, 'apiFormat') === 'gemini_native') return true;
  if (obj.includes('templateValues:')) return true;
  return false;
}

function protocolFor(group, obj) {
  const format = strField(obj, 'apiFormat');
  if (format === 'openai_responses') return 'responses';
  if (format === 'openai_chat') return 'openai';
  if (format === 'anthropic') return 'anthropic';
  if (group === 'claude') return 'anthropic';
  return 'openai';
}

function catalogFromModels(models, fallback) {
  const list = [];
  const seen = new Set();
  for (const item of models) {
    const model = String(item.model || item.id || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const row = { model, displayName: String(item.displayName || model).trim() };
    if (item.contextWindow) row.contextWindow = Number(item.contextWindow) || undefined;
    if (Array.isArray(item.reasoningLevels) && item.reasoningLevels.length) row.reasoningLevels = item.reasoningLevels;
    if (item.defaultReasoningLevel) row.defaultReasoningLevel = item.defaultReasoningLevel;
    list.push(row);
  }
  if (!list.length && fallback) list.push({ model: fallback, displayName: fallback });
  return list;
}

function parseModelCatalog(obj) {
  const start = obj.indexOf('modelCatalog:');
  if (start < 0) return [];
  const slice = obj.slice(start);
  const models = [];
  const objectBlocks = splitTopObjects(slice.replace(/^modelCatalog:\s*modelCatalog\(\[/, '{ _:[') );
  // Fallback: scan model: "..." with nearby displayName
  const parts = slice.split(/\{\s*model:/).slice(1);
  for (const part of parts) {
    const model = (part.match(/^\s*"((?:\\.|[^"\\])*)"/) || [])[1];
    if (!model) continue;
    const displayName = (part.match(/displayName:\s*"((?:\\.|[^"\\])*)"/) || [])[1] || decodeStr(model);
    const contextWindow = Number((part.match(/contextWindow:\s*(\d+)/) || [])[1] || 0) || undefined;
    const levelsMatch = part.match(/reasoningLevels:\s*\[([^\]]*)\]/);
    const reasoningLevels = levelsMatch
      ? [...levelsMatch[1].matchAll(/"([^"]+)"/g)].map(x => x[1])
      : undefined;
    const defaultReasoningLevel = (part.match(/defaultReasoningLevel:\s*"([^"]+)"/) || [])[1];
    models.push({
      model: decodeStr(model),
      displayName: decodeStr(displayName),
      contextWindow,
      reasoningLevels,
      defaultReasoningLevel,
    });
    if (part.includes(']),') || part.includes('])')) {
      // keep going; multiple entries
    }
  }
  void objectBlocks;
  return models;
}

function claudeModelConfig(env) {
  const config = { env: {} };
  for (const key of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  ]) {
    if (env[key]) config.env[key] = env[key];
  }
  if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    const n = Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
    if (Number.isFinite(n) && n > 0) config.contextWindow = n;
  }
  if (env.ANTHROPIC_MODEL) config.defaultEffort = 'high';
  return config;
}

function openaiModelConfig(model, catalog, effort = 'high', contextWindow) {
  const config = {
    defaultModel: model || '',
    defaultEffort: effort,
    catalog: catalogFromModels(catalog, model),
  };
  if (contextWindow) config.contextWindow = contextWindow;
  else if (config.catalog[0]?.contextWindow) config.contextWindow = config.catalog[0].contextWindow;
  return config;
}

function toPreset(group, obj) {
  if (skipObject(obj)) return null;
  const name = displayName(obj);
  if (!name) return null;
  const env = envMap(obj);
  const gen = callArgs(obj, 'generateThirdPartyConfig');
  const grok = callArgs(obj, 'grokPresetConfig');
  let baseUrl = strField(obj, 'baseURL')
    || env.ANTHROPIC_BASE_URL
    || env.GOOGLE_GEMINI_BASE_URL
    || env.GEMINI_BASE_URL
    || tomlField(obj, 'base_url')
    || gen[1]
    || grok[1]
    || '';
  if (baseUrl.includes('${')) return null;
  const model = strField(obj, 'model')
    || env.ANTHROPIC_MODEL
    || env.GEMINI_MODEL
    || tomlField(obj, 'model')
    || gen[2]
    || grok[2]
    || '';
  const catalog = parseModelCatalog(obj);
  const protocol = protocolFor(group, obj);
  const id = slug(name);
  const preset = {
    id,
    name,
    protocol,
    baseUrl,
    websiteUrl: strField(obj, 'websiteUrl'),
    apiKeyUrl: strField(obj, 'apiKeyUrl'),
    category: strField(obj, 'category') || 'third_party',
    icon: strField(obj, 'icon'),
    iconColor: strField(obj, 'iconColor'),
    endpointCandidates: strArray(obj, 'endpointCandidates').filter(Boolean),
    modelsUrl: strField(obj, 'modelsUrl'),
  };
  if (boolField(obj, 'isPartner')) preset.isPartner = true;
  if (boolField(obj, 'primePartner')) preset.primePartner = true;
  const promo = strField(obj, 'partnerPromotionKey');
  if (promo) preset.partnerPromotionKey = promo;
  const themeBlock = obj.match(/theme\s*:\s*\{([\s\S]*?)\}/);
  if (themeBlock) {
    const themeBg = strField(themeBlock[1], 'backgroundColor');
    const themeFg = strField(themeBlock[1], 'textColor');
    if (themeBg) {
      preset.theme = { backgroundColor: themeBg };
      if (themeFg) preset.theme.textColor = themeFg;
    }
  }
  if (group === 'claude') preset.modelConfig = claudeModelConfig(env);
  else if (group === 'gemini') preset.modelConfig = openaiModelConfig(model, catalog.length ? catalog : (model ? [{ model, displayName: model }] : []), 'high', 1048576);
  else if (group === 'grok') preset.modelConfig = openaiModelConfig(model || 'grok-4.5', catalog, 'high', 131072);
  else preset.modelConfig = openaiModelConfig(model, catalog, 'high', catalog[0]?.contextWindow);
  if (preset.category === 'custom') {
    preset.id = 'custom';
    preset.name = '自定义供应商';
  }
  return preset;
}

function extractArray(file, exportName) {
  const text = fs.readFileSync(path.join(configDir, file), 'utf8');
  const marker = `export const ${exportName}`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`missing ${exportName} in ${file}`);
  const bracket = text.indexOf('[', start);
  return splitTopObjects(text.slice(bracket + 1));
}

function uniqueByName(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (seen.has(item.id)) {
      let extra = '';
      try { extra = new URL(item.websiteUrl || item.baseUrl).hostname.replace(/[^a-z0-9]+/gi, '-'); }
      catch { extra = String(out.length); }
      item.id = `${item.id}-${extra || out.length}`.replace(/-+$/g, '');
    }
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function ensureCustom(list, group) {
  const protocol = group === 'claude' ? 'anthropic' : group === 'codex' ? 'responses' : 'openai';
  if (list.some(p => p.id === 'custom' || p.category === 'custom')) {
    return list.map(p => (p.category === 'custom' || p.id === 'custom')
      ? { ...p, id: 'custom', name: '自定义供应商', baseUrl: p.baseUrl || '', protocol }
      : p);
  }
  list.push({
    id: 'custom',
    name: '自定义供应商',
    protocol,
    baseUrl: '',
    websiteUrl: '',
    category: 'custom',
    endpointCandidates: [],
    modelConfig: group === 'claude'
      ? { env: {} }
      : { defaultModel: '', defaultEffort: '', catalog: [] },
  });
  return list;
}

function copyIcons(presets) {
  fs.mkdirSync(outIcons, { recursive: true });
  for (const name of fs.readdirSync(outIcons)) fs.unlinkSync(path.join(outIcons, name));
  const indexText = fs.readFileSync(path.join(iconDir, 'index.ts'), 'utf8');
  const svgMap = new Map();
  const body = indexText.slice(indexText.indexOf('export const icons'));
  const re = /(?:^|\n)\s*(?:["']([^"']+)["']|([A-Za-z0-9_-]+))\s*:\s*`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1] || m[2];
    const svg = m[3].trim();
    if (svg.startsWith('<svg')) svgMap.set(name, svg);
  }
  const files = {};
  for (const name of fs.readdirSync(iconDir)) {
    const ext = path.extname(name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext)) continue;
    fs.copyFileSync(path.join(iconDir, name), path.join(outIcons, name));
    files[path.basename(name, ext)] = name;
  }
  for (const [key, srcName] of Object.entries(RASTER_COPY)) {
    const src = path.join(iconDir, srcName);
    if (!fs.existsSync(src)) continue;
    const ext = path.extname(srcName);
    const destName = `${key}${ext}`;
    if (!fs.existsSync(path.join(outIcons, destName))) {
      fs.copyFileSync(src, path.join(outIcons, destName));
    }
    files[key] = fs.existsSync(path.join(outIcons, destName)) ? destName : srcName;
  }
  const used = new Set(presets.flatMap(p => p.icon ? [p.icon] : []));
  for (const name of new Set([...used, ...svgMap.keys()])) {
    if (files[name]) continue;
    const svg = svgMap.get(name);
    if (!svg) continue;
    const destName = `${name}.svg`;
    fs.writeFileSync(path.join(outIcons, destName), svg);
    files[name] = destName;
  }
  return files;
}

const promotions = JSON.parse(fs.readFileSync(path.join(cc, 'src', 'i18n', 'locales', 'zh.json'), 'utf8')).providerForm.partnerPromotion;

const claude = uniqueByName(extractArray('claudeProviderPresets.ts', 'providerPresets').map(o => toPreset('claude', o)).filter(Boolean));
const codex = uniqueByName(extractArray('codexProviderPresets.ts', 'codexProviderPresets').map(o => toPreset('codex', o)).filter(Boolean));
const gemini = uniqueByName(extractArray('geminiProviderPresets.ts', 'geminiProviderPresets').map(o => toPreset('gemini', o)).filter(Boolean));
const grok = uniqueByName(extractArray('grokBuildProviderPresets.ts', 'grokBuildProviderPresets').map(o => toPreset('grok', o)).filter(Boolean));

const presets = {
  claude: ensureCustom(claude, 'claude'),
  codex: ensureCustom(codex, 'codex'),
  gemini: ensureCustom(gemini, 'gemini'),
  grok: ensureCustom(grok, 'grok'),
};

const iconFiles = copyIcons(Object.values(presets).flat());
for (const group of Object.values(presets)) {
  for (const p of group) {
    if (p.icon && iconFiles[p.icon]) p.iconFile = iconFiles[p.icon];
  }
}

const banner = `// Generated from CC Switch provider presets (MIT, Copyright 2025 Jason Young).
// Do not edit by hand; rerun scripts/extract-cc-switch-presets.mjs
`;

const helper = `
export const CATEGORY_LABELS = {
  cn_official: '国产官方',
  third_party: '第三方',
  aggregator: '聚合',
  custom: '自定义',
  cloud_provider: '云厂商',
};

export const PARTNER_PROMOTIONS = ${JSON.stringify(promotions, null, 2)};

export const ICON_FILES = ${JSON.stringify(iconFiles, null, 2)};

const OFFICIAL_DEFAULTS = ${JSON.stringify(OFFICIAL_DEFAULTS, null, 2)};

const PROVIDER_PRESETS = ${JSON.stringify(presets, null, 2)};

export function getPresets(group) {
  return PROVIDER_PRESETS[group] || [];
}

export function getOfficialPreset(group) {
  return OFFICIAL_DEFAULTS[group] || null;
}

export function listIcons() {
  return Object.keys(ICON_FILES).sort((a, b) => a.localeCompare(b));
}

export function presetIconSrc(icon) {
  const file = ICON_FILES[icon];
  return file ? '/icons/' + file : '';
}

export function filterPresets(presets, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return presets;
  return presets.filter(p => [p.name, p.baseUrl, p.websiteUrl, p.category].filter(Boolean).join(' ').toLowerCase().includes(q));
}

export function sortPresets(presets, mode = 'original') {
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh');
  const isCustom = p => p.category === 'custom' || p.id === 'custom';
  const custom = presets.filter(isCustom);
  const others = presets.filter(p => !isCustom(p));
  if (mode === 'nameAsc') return [...custom, ...others.sort(byName)];
  const official = others.filter(p => p.category === 'official');
  const prime = others.filter(p => p.category !== 'official' && p.primePartner);
  const partner = others.filter(p => p.category !== 'official' && !p.primePartner && p.isPartner);
  const rest = others.filter(p => p.category !== 'official' && !p.primePartner && !p.isPartner).sort(byName);
  return [...custom, ...official, ...prime, ...partner, ...rest];
}
`;

fs.writeFileSync(path.join(root, 'public', 'provider-presets.js'), banner + helper.trimStart());
console.log(JSON.stringify({
  counts: Object.fromEntries(Object.entries(presets).map(([k, v]) => [k, v.length])),
  icons: Object.keys(iconFiles).length,
}, null, 2));
