import { icons } from './shell.js';
import {
  CLAUDE_FIELDS,
  parseClaudeModels,
  hasClaudeOneMMarker,
  stripClaudeOneMMarker,
  setClaudeOneMMarker,
  modelSuggestions,
  defaultOutsideCatalog,
  usesModelCatalog,
  REASONING_LEVELS,
  REASONING_LABELS,
  hasModelConfig,
} from './model-selection.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const CLAUDE_ROLE_LABELS = {
  model: '默认模型',
  haiku: 'Haiku 模型',
  sonnet: 'Sonnet 模型',
  opus: 'Opus 模型',
  fable: 'Fable 模型',
  subagent: '子代理模型',
};

function field(name, label, value, placeholder = '') {
  return `<label>${label}<span class="model-input-row"><input name="${name}" value="${esc(value)}" autocomplete="off" placeholder="${esc(placeholder)}"><button type="button" data-action="pick-model" data-field="${name}" aria-label="选择${label}">⌄</button></span></label>`;
}

function effortOptions(selected = '', allowed = REASONING_LEVELS) {
  return `<option value="">未设置</option>${allowed.map(level =>
    `<option value="${level}" ${selected === level ? 'selected' : ''}>${REASONING_LABELS[level]} (${level})</option>`
  ).join('')}`;
}

function effortSelect(name, value, label = '默认努力程度') {
  return `<label>${label}<select name="${name}">${effortOptions(value)}</select></label>`;
}

function contextField(name, value, label = '上下文大小') {
  return `<label>${label}<input name="${name}" inputmode="numeric" pattern="[0-9]*" value="${esc(value ?? '')}" autocomplete="off" placeholder="例如 128000"></label>`;
}

function modelProbeButtons(extra = '') {
  return `<div class="catalog-toolbar-actions">
    <button type="button" class="secondary cc-btn-with-icon" data-dialog-action="test">${icons.test} <span>发送测试</span></button>
    <button type="button" class="secondary" data-dialog-action="fetch-models"><span>拉取模型</span></button>
    ${extra}
  </div>`;
}

function selectedLevels(row = {}) {
  const raw = Array.isArray(row.reasoningLevels) ? row.reasoningLevels : [];
  return REASONING_LEVELS.filter(level => raw.includes(level));
}

export function catalogRow(row = {}) {
  const levels = selectedLevels(row);
  const defaultLevel = levels.includes(row.defaultReasoningLevel) ? row.defaultReasoningLevel : '';
  const levelLabel = levels.length ? levels.join(', ') : '未设置';
  const effortModels = row.effortModels && typeof row.effortModels === 'object' ? JSON.stringify(row.effortModels) : '';
  return `<div data-catalog-row class="model-map-row"${effortModels ? ` data-effort-models="${esc(effortModels)}"` : ''}>
    <input data-map-name value="${esc(row.displayName)}" aria-label="菜单显示名" placeholder="显示名称">
    <span class="model-input-row">
      <input data-map-model value="${esc(row.model)}" aria-label="实际请求模型" placeholder="实际请求模型">
      <button type="button" data-action="pick-model" aria-label="选择实际请求模型">⌄</button>
    </span>
    <input data-map-context inputmode="numeric" pattern="[0-9]*" value="${esc(row.contextWindow ?? '')}" aria-label="上下文窗口" placeholder="128000">
    <div class="effort-picker">
      <button type="button" class="effort-trigger" data-action="toggle-effort-menu" aria-haspopup="listbox" aria-label="思考等级">${esc(levelLabel)}</button>
      <div class="effort-menu" hidden>
        ${REASONING_LEVELS.map(level => `<label class="effort-option"><input type="checkbox" data-map-level value="${level}" ${levels.includes(level) ? 'checked' : ''}>${REASONING_LABELS[level]} <span class="muted">${level}</span></label>`).join('')}
        <label class="effort-default">行默认<select data-map-default-level aria-label="该模型默认努力程度">${effortOptions(defaultLevel, levels)}</select></label>
      </div>
    </div>
    <button type="button" data-action="remove-model-row" aria-label="移除此模型">×</button>
  </div>`;
}

export function syncEffortPicker(picker) {
  if (!picker) return;
  const levels = REASONING_LEVELS.filter(level => picker.querySelector(`[data-map-level][value="${level}"]`)?.checked);
  const trigger = picker.querySelector('.effort-trigger');
  if (trigger) trigger.textContent = levels.length ? levels.join(', ') : '未设置';
  const select = picker.querySelector('[data-map-default-level]');
  if (!select) return;
  const current = levels.includes(select.value) ? select.value : '';
  select.innerHTML = effortOptions(current, levels);
}

function readCatalogRow(row) {
  const model = row.querySelector('[data-map-model]').value.trim();
  const displayName = row.querySelector('[data-map-name]').value.trim();
  const contextWindow = row.querySelector('[data-map-context]').value.trim();
  const reasoningLevels = REASONING_LEVELS.filter(level => row.querySelector(`[data-map-level][value="${level}"]`)?.checked);
  const defaultReasoningLevel = row.querySelector('[data-map-default-level]')?.value || '';
  const out = { model, displayName, contextWindow, reasoningLevels, defaultReasoningLevel };
  const raw = row.getAttribute('data-effort-models');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.effortModels = parsed;
    } catch { /* ignore malformed row metadata */ }
  }
  return out;
}

export function modelConfigFields(connection, group) {
  const config = connection.modelConfigs?.[group] || {};
  let fields;
  if (group === 'claude') {
    const parsed = parseClaudeModels(config.env);
    fields = Object.entries(CLAUDE_FIELDS).map(([role, key]) =>
      field(key, CLAUDE_ROLE_LABELS[role], stripClaudeOneMMarker(parsed[role]))
      + `<label class="one-m"><input type="checkbox" name="${key}_oneM" ${hasClaudeOneMMarker(parsed[role]) ? 'checked' : ''}>1M 上下文</label>`
      + (['haiku', 'sonnet', 'opus', 'fable'].includes(role)
        ? field(key + '_NAME', '显示名称', config.env?.[key + '_NAME'] ?? stripClaudeOneMMarker(parsed[role]))
        : '')
    ).join('')
      + `<div class="model-defaults">${effortSelect('defaultEffort', config.defaultEffort || '')}</div>`;
  } else {
    fields = `<div class="model-defaults">${field('defaultModel', '默认模型', config.defaultModel || '', '例如 gpt-5.4')}${effortSelect('defaultEffort', config.defaultEffort || '')}${contextField('contextWindow', config.contextWindow)}</div>
      <p class="muted">默认模型与默认努力程度用于新会话；上下文大小为 token 上限，可在模型列表中按行覆盖。</p>`;
  }
  const catalog = usesModelCatalog(group) ? `
    <div class="catalog-toolbar">
      <h3>模型列表</h3>
      ${modelProbeButtons('<button type="button" data-action="add-model-row">＋ 添加模型</button>')}
    </div>
    <div class="model-map-head" aria-hidden="true">
      <span>菜单显示名</span>
      <span>实际请求模型</span>
      <span>上下文窗口</span>
      <span>思考等级</span>
      <span></span>
    </div>
    <div data-catalog-rows>${(config.catalog || []).map(catalogRow).join('')}</div>
    <p class="muted" data-default-warning ${defaultOutsideCatalog(config) ? '' : 'hidden'}>默认模型不在列表中；仍可保存。<button type="button" data-action="add-default-row">加入列表</button></p>
  ` : '';
  const heading = usesModelCatalog(group)
    ? '<h3>模型选择</h3>'
    : `<div class="catalog-toolbar"><h3>模型选择</h3>${modelProbeButtons()}</div>`;
  return `<section data-model-config data-group="${group}">${heading}${fields}${catalog}</section>`;
}

export function readModelConfig(container) {
  const section = container.querySelector('[data-model-config]');
  const group = section.dataset.group;
  const defaultEffort = section.querySelector('[name=defaultEffort]')?.value.trim() || '';
  const contextWindow = section.querySelector('[name=contextWindow]')?.value.trim() || '';
  if (group === 'claude') {
    const env = {};
    for (const key of Object.values(CLAUDE_FIELDS)) {
      env[key] = setClaudeOneMMarker(section.querySelector(`[name="${key}"]`).value, section.querySelector(`[name="${key}_oneM"]`).checked);
      const name = section.querySelector(`[name="${key}_NAME"]`);
      if (name) env[key + '_NAME'] = name.value.trim();
    }
    return { env, defaultEffort };
  }
  const result = {
    defaultModel: section.querySelector('[name=defaultModel]').value.trim(),
    defaultEffort,
    contextWindow,
  };
  if (usesModelCatalog(group)) {
    result.catalog = [...section.querySelectorAll('[data-catalog-row]')].map(readCatalogRow).filter(row => row.model);
  }
  return result;
}

export function updateDefaultWarning(container) {
  const warning = container.querySelector('[data-default-warning]');
  if (!warning) return;
  warning.hidden = !defaultOutsideCatalog(readModelConfig(container));
}

export { modelSuggestions, hasModelConfig };
