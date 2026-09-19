// Endpoint ordering ported from CC Switch services/model_fetch.rs (MIT).
// Official Codex list shape follows CC Switch services/codex_oauth_models.rs (MIT).
import { normalizeModels, REASONING_LEVELS, stripClaudeOneMMarker } from '../public/model-selection.js';
import { CODEX_CLI_ORIGINATOR, CODEX_CLI_USER_AGENT } from './official-client-http.mjs';
import { applyRequestTimezone, applyResponseTimezone } from './session-timezone.mjs';

const suffixes = ['/api/claudecode', '/api/anthropic', '/apps/anthropic', '/api/coding', '/claudecode', '/anthropic', '/step_plan', '/coding', '/claude'];
const FETCH_TIMEOUT_MS = 15000;
const TEST_TIMEOUT_MS = 25000;
export const TEST_PROMPT = 'hi';
const TEST_MAX_OUTPUT_TOKENS = 128;
const MAX_ERROR_SNIPPET = 200;
const MAX_MODELS = 200;
const CLAUDE_MODELS_PAGES = 5;

export const CODEX_CLI_VERSION = (CODEX_CLI_USER_AGENT.match(/codex_cli_rs\/(\d+\.\d+\.\d+)/) || [])[1] || '0.154.0';
export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
export const CLAUDE_MODELS_URL = 'https://api.anthropic.com/v1/models';
export const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const GROK_MODELS_URL = 'https://api.x.ai/v1/models';
export const GROK_CHAT_URL = 'https://api.x.ai/v1/chat/completions';
export const GEMINI_MODELS_PATH = '/v1internal:fetchAvailableModels';
export const GEMINI_LOAD_PATH = '/v1internal:loadCodeAssist';
export const GEMINI_GENERATE_PATH = '/v1internal:generateContent';
export const GEMINI_STREAM_PATH = '/v1internal:streamGenerateContent?alt=sse';
export const GEMINI_MODELS_BASES = Object.freeze([
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
]);
export const GEMINI_STUDIO_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
export const ANTIGRAVITY_USER_AGENT = 'antigravity/hub/2.9.1 windows/amd64';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

export function safeModelUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('模型地址不能包含凭据、查询或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('远程模型地址必须使用 HTTPS');
  return url;
}

export function modelUrlCandidates(base, override = '') {
  if (override.trim()) {
    safeModelUrl(override.trim());
    return [override.trim()];
  }
  const root = base.trim().replace(/\/+$/, '');
  safeModelUrl(root);
  const candidates = /\/v\d+$/.test(root)
    ? [root + '/models', ...(root.endsWith('/v1') ? [] : [root + '/v1/models'])]
    : [root + '/v1/models'];
  const suffix = suffixes.find(s => root.endsWith(s));
  if (suffix) {
    const stripped = root.slice(0, -suffix.length);
    candidates.push(stripped + '/v1/models', stripped + '/models');
  }
  return [...new Set(candidates)];
}

function snippet(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length <= MAX_ERROR_SNIPPET ? value : `${value.slice(0, MAX_ERROR_SNIPPET)}...`;
}

function httpError(status, body = '') {
  const detail = snippet(body);
  return new Error(detail ? `模型获取失败：HTTP ${status} ${detail}` : `模型获取失败：HTTP ${status}`);
}

function field(entry, keys) {
  if (!entry || typeof entry !== 'object') return '';
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function stripModelPrefix(id) {
  return String(id || '').trim().replace(/^models\//, '');
}

function compactName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function displayNameFits(id, displayName) {
  if (!displayName || displayName === id) return false;
  const a = compactName(id);
  const b = compactName(displayName);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function slugifyFamilyName(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/gpt[\s-]*oss/g, 'gpt-oss')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function geminiAgentSortIds(data) {
  const sorts = data?.agentModelSorts || data?.agent_model_sorts || [];
  const ids = [];
  for (const sort of Array.isArray(sorts) ? sorts : []) {
    for (const group of sort?.groups || []) {
      for (const id of group?.modelIds || group?.model_ids || []) {
        const value = stripModelPrefix(id);
        if (value) ids.push(value);
      }
    }
  }
  return ids;
}

// Antigravity CLI /model picker groups by 型号 (Gemini 3.8 Flash) and uses --effort
// (low|medium|high) to pick the request slug. Display names like "Gemini 3.5 Flash (Low)"
// may map to irregular slugs such as gemini-3.5-flash-extra-low.
function geminiFamilyInfo(id, entry) {
  if (/-(tiered)$/i.test(id)) return null;
  const display = typeof entry === 'object' ? field(entry, ['displayName', 'display_name', 'title']) : '';
  const paren = display.match(/^(.*)\s+\((low|medium|high)\)$/i);
  if (paren) {
    const familyName = paren[1].trim();
    return { base: slugifyFamilyName(familyName) || id, familyName, effort: paren[2].toLowerCase() };
  }
  const slug = id.match(/^(.*)-(extra-low|low|medium|high)$/i);
  if (slug) {
    const token = slug[2].toLowerCase();
    return { base: slug[1], familyName: '', effort: token === 'extra-low' ? 'low' : token };
  }
  return { base: id, familyName: display, effort: '' };
}

function preferGeminiRequestId(base, effort, current, candidate) {
  if (!current) return candidate;
  const exact = `${base}-${effort}`;
  const extraLow = effort === 'low' ? `${base}-extra-low` : '';
  const rank = id => (id === exact ? 0 : id === extraLow ? 1 : id.startsWith(`${base}-`) ? 2 : 3);
  return rank(candidate) < rank(current) ? candidate : current;
}

export function groupGeminiCatalog(rawModels, sortIds = [], ownedBy = 'Google') {
  const families = new Map();
  const singles = [];
  for (const item of rawModels) {
    const id = stripModelPrefix(item.id);
    if (!id) continue;
    const entry = item.entry && typeof item.entry === 'object' ? item.entry : {};
    const info = geminiFamilyInfo(id, entry);
    if (!info) continue;
    if (!info.effort) {
      singles.push({ id, entry });
      continue;
    }
    let family = families.get(info.base);
    if (!family) {
      family = { base: info.base, familyName: info.familyName, contextWindow: '', efforts: new Map() };
      families.set(info.base, family);
    }
    if (info.familyName && !family.familyName) family.familyName = info.familyName;
    const context = parseContextWindow(entry);
    if (context !== '' && (family.contextWindow === '' || context > family.contextWindow)) family.contextWindow = context;
    const prev = family.efforts.get(info.effort);
    family.efforts.set(info.effort, { id: preferGeminiRequestId(info.base, info.effort, prev?.id, id) });
  }

  const sortIndex = new Map(sortIds.map((id, index) => [id, index]));
  const familyRank = base => {
    let best = sortIndex.has(base) ? sortIndex.get(base) : Number.POSITIVE_INFINITY;
    for (const item of families.get(base)?.efforts.values() || []) {
      const index = sortIndex.has(item.id) ? sortIndex.get(item.id) : Number.POSITIVE_INFINITY;
      if (index < best) best = index;
    }
    return best;
  };

  const grouped = [...families.keys()]
    .sort((a, b) => familyRank(a) - familyRank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(base => {
      const family = families.get(base);
      const reasoningLevels = REASONING_LEVELS.filter(level => family.efforts.has(level));
      const effortModels = {};
      for (const level of reasoningLevels) effortModels[level] = family.efforts.get(level).id;
      const displayName = family.familyName || '';
      const defaultReasoningLevel = reasoningLevels.includes('medium')
        ? 'medium'
        : reasoningLevels.includes('high')
          ? 'high'
          : (reasoningLevels[0] || '');
      const out = { id: base, ownedBy };
      if (displayName && displayName !== base) out.displayName = displayName;
      if (family.contextWindow !== '') out.contextWindow = family.contextWindow;
      if (reasoningLevels.length) out.reasoningLevels = reasoningLevels;
      if (defaultReasoningLevel) out.defaultReasoningLevel = defaultReasoningLevel;
      if (Object.keys(effortModels).length) out.effortModels = effortModels;
      return out;
    });

  const used = new Set(grouped.map(item => item.id));
  const ranked = [
    ...grouped.map(item => ({ item, rank: familyRank(item.id) })),
    ...singles
      .filter(item => !used.has(item.id))
      .map(item => catalogModel(item.entry, item.id, ownedBy, { preferKey: true }))
      .filter(Boolean)
      .map(item => ({
        item,
        rank: sortIndex.has(item.id) ? sortIndex.get(item.id) : Number.POSITIVE_INFINITY,
      })),
  ];
  ranked.sort((a, b) => a.rank - b.rank || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  return ranked.map(entry => entry.item).slice(0, MAX_MODELS);
}

function parseContextWindow(entry) {
  if (!entry || typeof entry !== 'object') return '';
  for (const key of ['contextWindow', 'context_window', 'max_context_window', 'maxTokens', 'max_tokens', 'inputTokenLimit']) {
    const value = entry[key];
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN);
    if (Number.isInteger(n) && n >= 1 && n <= 16_000_000) return n;
  }
  return '';
}

function parseReasoningLevels(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const raw = entry.reasoningLevels
    || entry.reasoning_levels
    || entry.supported_reasoning_levels
    || entry.supported_reasoning_efforts
    || entry.supportedReasoningLevels
    || [];
  if (!Array.isArray(raw)) return [];
  const picked = new Set();
  for (const item of raw) {
    const effort = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' ? (item.effort || item.level || item.id || '') : '');
    const level = String(effort || '').trim().toLowerCase();
    if (REASONING_LEVELS.includes(level)) picked.add(level);
  }
  return REASONING_LEVELS.filter(level => picked.has(level));
}

function parseDefaultReasoning(entry, levels) {
  const value = field(entry, ['defaultReasoningLevel', 'default_reasoning_level', 'default_reasoning_effort', 'defaultReasoningEffort']).toLowerCase();
  if (REASONING_LEVELS.includes(value) && (!levels.length || levels.includes(value))) return value;
  return '';
}

function catalogModel(entry, fallbackId = '', ownedBy = null, { preferKey = false } = {}) {
  const id = stripModelPrefix(
    typeof entry === 'string'
      ? entry
      : (preferKey ? fallbackId : '') || field(entry, ['slug', 'id', 'model', 'name']) || fallbackId,
  );
  if (!id) return null;
  const displayName = typeof entry === 'object'
    ? field(entry, ['displayName', 'display_name', 'title'])
    : '';
  const contextWindow = parseContextWindow(entry);
  const reasoningLevels = parseReasoningLevels(entry);
  const defaultReasoningLevel = parseDefaultReasoning(entry, reasoningLevels);
  const owner = typeof entry === 'object'
    ? field(entry, ['ownedBy', 'owned_by', 'provider', 'vendor', 'owner']) || ownedBy
    : ownedBy;
  const out = { id, ownedBy: owner || null };
  if (displayNameFits(id, displayName)) out.displayName = displayName;
  if (contextWindow !== '') out.contextWindow = contextWindow;
  if (reasoningLevels.length) out.reasoningLevels = reasoningLevels;
  if (defaultReasoningLevel) out.defaultReasoningLevel = defaultReasoningLevel;
  return out;
}

function pushUnique(list, seen, model) {
  if (!model?.id || seen.has(model.id)) return;
  seen.add(model.id);
  list.push(model);
}

function finish(list) {
  return list
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_MODELS);
}

export function parseModelPayload(data, kind = 'openai') {
  const seen = new Set();
  const list = [];
  const ownedBy = kind === 'codex' ? 'Codex'
    : kind === 'claude' ? 'Anthropic'
      : kind === 'grok' ? 'xAI'
        : kind === 'gemini' ? 'Google'
          : null;

  if (kind === 'gemini' && data && typeof data === 'object' && data.models && !Array.isArray(data.models) && typeof data.models === 'object') {
    const raw = [];
    for (const [key, entry] of Object.entries(data.models)) {
      if (/^(chat_|tab_|MODEL_PLACEHOLDER_)/i.test(key)) continue;
      const id = stripModelPrefix(key);
      if (!id) continue;
      raw.push({ id, entry: entry && typeof entry === 'object' ? entry : {} });
    }
    return groupGeminiCatalog(raw, geminiAgentSortIds(data), ownedBy);
  }

  const entries = Array.isArray(data)
    ? data
    : Array.isArray(data?.data) ? data.data
      : Array.isArray(data?.models) ? data.models
        : Array.isArray(data?.items) ? data.items
          : [];
  for (const entry of entries) pushUnique(list, seen, catalogModel(entry, '', ownedBy));

  if (kind === 'codex' && data?.models && !Array.isArray(data.models) && typeof data.models === 'object') {
    for (const [key, entry] of Object.entries(data.models)) {
      pushUnique(list, seen, catalogModel(entry, key, ownedBy));
    }
  }
  return finish(list);
}

async function readJson(response) {
  const text = await response.text();
  if (!response.ok) throw httpError(response.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('模型列表响应不是有效 JSON');
  }
}

export async function fetchModelCatalog(config, key, fetcher = fetch) {
  if (!key) throw new Error('请填写密钥或先保存连接密钥');
  const urls = modelUrlCandidates(config.baseUrl, config.modelsUrl || '');
  const headers = config.protocol === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${key}` };
  let lastMissing = false;
  for (const url of urls) {
    safeModelUrl(url);
    const r = await fetcher(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
    if (r.status === 404 || r.status === 405) {
      lastMissing = true;
      continue;
    }
    const data = await readJson(r);
    const kind = config.protocol === 'anthropic' ? 'claude' : 'openai';
    const models = parseModelPayload(data, kind);
    if (!models.length) {
      const fallback = normalizeModels(data.data || (Array.isArray(data.models) ? data.models.map(m => ({
        id: typeof m === 'string' ? m : m?.name?.replace(/^models\//, '') || m?.id,
        ownedBy: m?.ownedBy || m?.owned_by || null,
      })) : []));
      return finish(fallback.map(m => catalogModel(m)).filter(Boolean));
    }
    return models;
  }
  if (lastMissing) throw new Error('所有模型列表候选地址均返回 404/405，请配置模型列表地址');
  throw new Error('接口未返回模型列表，可手动填写模型标识');
}

async function fetchCodexModels({ accessToken, accountID, fetcher }) {
  if (!accountID) throw new Error('官方账号信息不完整，请重新登录后再拉取模型');
  const url = `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(CODEX_CLI_VERSION)}`;
  const response = await fetcher(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Originator: CODEX_CLI_ORIGINATOR,
      'User-Agent': CODEX_CLI_USER_AGENT,
      version: CODEX_CLI_VERSION,
      'chatgpt-account-id': accountID,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  return parseModelPayload(await readJson(response), 'codex');
}

async function fetchClaudeModels({ accessToken, fetcher }) {
  const seen = new Set();
  const list = [];
  let after = '';
  for (let page = 0; page < CLAUDE_MODELS_PAGES; page += 1) {
    const url = `${CLAUDE_MODELS_URL}?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const response = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': CLAUDE_OAUTH_BETA,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
    const data = await readJson(response);
    for (const model of parseModelPayload(data, 'claude')) pushUnique(list, seen, model);
    if (!data?.has_more || !data?.last_id || data.last_id === after) break;
    after = String(data.last_id);
  }
  return finish(list);
}

async function fetchGrokModels({ accessToken, fetcher }) {
  const response = await fetcher(GROK_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  return parseModelPayload(await readJson(response), 'grok');
}

function geminiHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_USER_AGENT,
  };
}

export function extractGeminiProject(data) {
  const value = data?.cloudaicompanionProject ?? data?.cloudAiCompanionProject;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    return String(value.id || value.projectId || value.project_id || '').trim();
  }
  return '';
}

async function loadGeminiProject({ accessToken, fetcher, base }) {
  const response = await fetcher(`${base}${GEMINI_LOAD_PATH}`, {
    method: 'POST',
    headers: geminiHeaders(accessToken),
    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!response.ok) return '';
  try {
    return extractGeminiProject(JSON.parse(await response.text()));
  } catch {
    return '';
  }
}

async function fetchGeminiModels({ accessToken, fetcher }) {
  let lastError;
  for (const base of GEMINI_MODELS_BASES) {
    try {
      const project = await loadGeminiProject({ accessToken, fetcher, base });
      const response = await fetcher(`${base}${GEMINI_MODELS_PATH}`, {
        method: 'POST',
        headers: geminiHeaders(accessToken),
        body: project ? JSON.stringify({ project }) : '{}',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'error',
      });
      if (response.status === 404 || response.status === 405 || response.status === 403) {
        lastError = httpError(response.status, await response.text().catch(() => ''));
        continue;
      }
      const models = parseModelPayload(await readJson(response), 'gemini');
      if (models.length) return models;
      lastError = new Error('接口未返回模型列表，可手动填写模型标识');
    } catch (error) {
      lastError = error;
    }
  }
  try {
    const studio = await fetcher(GEMINI_STUDIO_MODELS_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
    const models = parseModelPayload(await readJson(studio), 'gemini');
    if (models.length) return models;
  } catch (error) {
    lastError = lastError || error;
  }
  throw lastError || new Error('接口未返回模型列表，可手动填写模型标识');
}

export async function fetchOfficialModels(id, { accessToken, accountID, fetcher = fetch } = {}) {
  if (!accessToken) throw new Error('请先登录官方账号后再拉取模型');
  if (id === 'official-codex') return fetchCodexModels({ accessToken, accountID, fetcher });
  if (id === 'official-claude') return fetchClaudeModels({ accessToken, fetcher });
  if (id === 'official-grok') return fetchGrokModels({ accessToken, fetcher });
  if (id === 'official-gemini') return fetchGeminiModels({ accessToken, fetcher });
  throw new Error('该官方登录暂不支持拉取模型列表');
}

function bags(data) {
  if (!data || typeof data !== 'object') return [];
  const nested = data.response && typeof data.response === 'object' ? data.response : null;
  return nested ? [data, nested] : [data];
}

export function extractModelPreview(data) {
  const parts = [];
  for (const bag of bags(data)) {
    const choice = bag.choices?.[0]?.message?.content;
    if (typeof choice === 'string') parts.push(choice);
    else if (Array.isArray(choice)) parts.push(choice.map(item => item?.text || '').join(''));
    if (Array.isArray(bag.content)) parts.push(bag.content.map(item => item?.text || '').join(''));
    const candidateParts = bag.candidates?.[0]?.content?.parts;
    if (Array.isArray(candidateParts)) parts.push(candidateParts.map(item => item?.text || '').join(''));
    if (typeof bag.output_text === 'string') parts.push(bag.output_text);
    if (Array.isArray(bag.output)) {
      for (const item of bag.output) {
        if (typeof item?.content === 'string') parts.push(item.content);
        else if (Array.isArray(item?.content)) parts.push(item.content.map(block => block?.text || block?.output_text || '').join(''));
      }
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function hasModelReply(data) {
  for (const bag of bags(data)) {
    if (Array.isArray(bag.choices) && bag.choices.length) return true;
    if (Array.isArray(bag.content) && bag.content.length) return true;
    if (Array.isArray(bag.candidates) && bag.candidates.length) return true;
    if (Array.isArray(bag.output) && bag.output.length) return true;
    if (typeof bag.output_text === 'string' && bag.output_text.trim()) return true;
  }
  return false;
}

export function decodeModelResponse(text) {
  const raw = String(text || '');
  if (looksLikeSse(raw)) return parseSsePayload(raw);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('供应商响应不是有效 JSON');
  }
}

function officialHttpError(status, body = '') {
  const detail = snippet(body);
  return new Error(detail ? `官方模型请求失败：HTTP ${status} ${detail}` : `官方模型请求失败：HTTP ${status}`);
}

function responseContentType(response) {
  const headers = response?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get('content-type') || '';
  return headers['content-type'] || headers['Content-Type'] || '';
}

function looksLikeSse(text) {
  const start = String(text || '').trimStart();
  return start.startsWith('data:') || start.startsWith('event:');
}

function parseSsePayload(text) {
  const events = [];
  const deltas = [];
  for (const block of String(text).split(/\n\n+/)) {
    for (const line of block.split(/\n/)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const event = JSON.parse(raw);
        events.push(event);
        if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') deltas.push(event.delta);
        const parts = event?.response?.candidates?.[0]?.content?.parts || event?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (typeof part?.text === 'string' && part.text && !part.thought) deltas.push(part.text);
          }
        }
      } catch { /* skip malformed SSE */ }
    }
  }
  if (deltas.length) return { output_text: deltas.join('') };
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (hasModelReply(events[i])) return events[i];
  }
  return events.at(-1) || {};
}

async function postOfficial(fetcher, url, { headers, payload, timezone }) {
  const t0 = Date.now();
  const response = await fetcher(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(applyRequestTimezone(payload, timezone)),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    redirect: 'error',
  });
  const durationMs = Date.now() - t0;
  const text = await response.text();
  if (!response.ok) throw officialHttpError(response.status, text);
  const type = responseContentType(response);
  let data;
  if (type.includes('text/event-stream') || looksLikeSse(text)) {
    data = parseSsePayload(text);
  } else {
    try { data = JSON.parse(text); } catch { throw new Error('官方模型响应不是有效 JSON'); }
  }
  data = applyResponseTimezone(data, timezone);
  if (!hasModelReply(data)) throw new Error('API 已响应，但未返回有效模型内容');
  const preview = extractModelPreview(data);
  return preview ? { message: '模型请求成功', durationMs, preview } : { message: '模型请求成功', durationMs };
}

async function testCodexModel({ accessToken, accountID, model, effort, timezone, fetcher }) {
  if (!accountID) throw new Error('官方账号信息不完整，请重新登录后再测试模型');
  const payload = {
    model,
    instructions: '',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: TEST_PROMPT }] }],
    store: false,
    stream: true,
  };
  if (effort) payload.reasoning = { effort };
  return postOfficial(fetcher, CODEX_RESPONSES_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'text/event-stream',
      Originator: CODEX_CLI_ORIGINATOR,
      'User-Agent': CODEX_CLI_USER_AGENT,
      version: CODEX_CLI_VERSION,
      'chatgpt-account-id': accountID,
      Session_id: crypto.randomUUID(),
    },
    payload,
    timezone,
  });
}

async function testClaudeModel({ accessToken, model, timezone, fetcher }) {
  return postOfficial(fetcher, CLAUDE_MESSAGES_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': CLAUDE_OAUTH_BETA,
    },
    payload: {
      model: stripClaudeOneMMarker(model),
      max_tokens: TEST_MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: TEST_PROMPT }],
    },
    timezone,
  });
}

async function testGrokModel({ accessToken, model, timezone, fetcher }) {
  return postOfficial(fetcher, GROK_CHAT_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    payload: {
      model,
      messages: [{ role: 'user', content: TEST_PROMPT }],
      max_tokens: TEST_MAX_OUTPUT_TOKENS,
    },
    timezone,
  });
}

async function testGeminiModel({ accessToken, model, timezone, fetcher }) {
  let lastError;
  for (const base of GEMINI_MODELS_BASES) {
    try {
      const project = await loadGeminiProject({ accessToken, fetcher, base });
      const payload = {
        model,
        userAgent: 'antigravity',
        requestType: 'agent',
        requestId: `agent-${crypto.randomUUID()}`,
        request: {
          contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
          generationConfig: { maxOutputTokens: TEST_MAX_OUTPUT_TOKENS },
        },
      };
      if (project) payload.project = project;
      const headers = geminiHeaders(accessToken);
      try {
        return await postOfficial(fetcher, `${base}${GEMINI_STREAM_PATH}`, {
          headers: { ...headers, Accept: 'text/event-stream' },
          payload,
          timezone,
        });
      } catch (streamError) {
        lastError = streamError;
        return await postOfficial(fetcher, `${base}${GEMINI_GENERATE_PATH}`, {
          headers,
          payload,
          timezone,
        });
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('官方模型请求失败');
}

const ENDPOINT_MIN_TIMEOUT_SECS = 2;
const ENDPOINT_MAX_TIMEOUT_SECS = 30;
const ENDPOINT_DEFAULT_TIMEOUT_SECS = 8;
const ENDPOINT_MAX_URLS = 20;

export function sanitizeEndpointTimeout(timeoutSecs) {
  const secs = Number(timeoutSecs);
  const value = Number.isFinite(secs) ? secs : ENDPOINT_DEFAULT_TIMEOUT_SECS;
  return Math.min(ENDPOINT_MAX_TIMEOUT_SECS, Math.max(ENDPOINT_MIN_TIMEOUT_SECS, value));
}

export async function testApiEndpoints(urls, timeoutSecs = ENDPOINT_DEFAULT_TIMEOUT_SECS, fetcher = fetch) {
  const list = Array.isArray(urls) ? urls.slice(0, ENDPOINT_MAX_URLS) : [];
  const timeoutMs = sanitizeEndpointTimeout(timeoutSecs) * 1000;
  return Promise.all(list.map(async raw => {
    const url = String(raw || '').trim();
    if (!url) return { url: raw, latency: null, status: null, error: 'URL 不能为空' };
    try {
      safeModelUrl(url);
    } catch (error) {
      return { url, latency: null, status: null, error: error.message };
    }
    try {
      await fetcher(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch {
      /* warmup is best-effort */
    }
    const t0 = Date.now();
    try {
      const response = await fetcher(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      return { url, latency: Date.now() - t0, status: response.status, error: null };
    } catch (error) {
      return {
        url,
        latency: null,
        status: null,
        error: error.name === 'TimeoutError' ? '请求超时' : (error.message === 'fetch failed' ? '连接失败' : error.message),
      };
    }
  }));
}

export async function testOfficialModel(id, { accessToken, accountID, model, effort, timezone, fetcher = fetch } = {}) {
  if (!accessToken) throw new Error('请先登录官方账号后再测试模型');
  const requestModel = String(model || '').trim();
  if (!requestModel) throw new Error('请填写要测试的模型');
  const level = REASONING_LEVELS.includes(String(effort || '').trim().toLowerCase())
    ? String(effort).trim().toLowerCase()
    : '';
  if (id === 'official-codex') return testCodexModel({ accessToken, accountID, model: requestModel, effort: level, timezone, fetcher });
  if (id === 'official-claude') return testClaudeModel({ accessToken, model: requestModel, timezone, fetcher });
  if (id === 'official-grok') return testGrokModel({ accessToken, model: requestModel, timezone, fetcher });
  if (id === 'official-gemini') return testGeminiModel({ accessToken, model: requestModel, timezone, fetcher });
  throw new Error('该官方登录暂不支持连通检测');
}
