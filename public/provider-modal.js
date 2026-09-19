// Adapted from CC Switch AddProviderDialog & ProviderForm (MIT, Copyright 2025 Jason Young).
import { icons, esc } from './shell.js';
import { getPresets, getOfficialPreset, filterPresets, sortPresets, presetIconSrc, CATEGORY_LABELS, PARTNER_PROMOTIONS, ICON_FILES } from './provider-presets.js';
import { modelConfigFields, readModelConfig, catalogRow, updateDefaultWarning, syncEffortPicker, modelSuggestions, hasModelConfig } from './model-config-ui.js';
import { MODEL_GROUPS } from './model-groups.js';
import { defaultProtocolForGroup, isValidProtocol, PROTOCOL_HINT, protocolSelectOptions } from './protocols.js';
import { notice } from './toast.js';

let activeDialog = null;
const ENDPOINT_TIMEOUT = { claude: 8, codex: 12, gemini: 8, grok: 12 };

function seedOfficialConfig(conn, group) {
  if (!String(conn.id || '').startsWith('official-')) return conn;
  const stored = conn.modelConfigs?.[group];
  if (hasModelConfig(stored)) return conn;
  const preset = getOfficialPreset(group);
  if (!preset?.modelConfig) return conn;
  conn.modelConfigs = { ...(conn.modelConfigs || {}), [group]: JSON.parse(JSON.stringify(preset.modelConfig)) };
  return conn;
}

function iconImg(icon, color, className = 'cc-icon-img') {
  const src = presetIconSrc(icon);
  if (!src) return '';
  const style = color ? ` style="color:${esc(color)}"` : '';
  return `<img class="${className}" src="${esc(src)}" alt=""${style}>`;
}

function categoryHint(category) {
  switch (category) {
    case 'cn_official': return '💡 国产官方供应商只需填写 API Key，请求地址已预设';
    case 'aggregator': return '💡 聚合服务供应商只需填写 API Key 即可使用';
    case 'third_party': return '💡 第三方供应商需要填写 API Key 和请求地址';
    case 'cloud_provider': return '💡 云厂商供应商需要填写 API Key 和请求地址';
    case 'custom': return '💡 自定义配置需手动填写所有必要字段';
    default: return '选择预设后可继续调整下方字段。';
  }
}

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function uniqueEndpoints(items) {
  const map = new Map();
  for (const item of items) {
    const url = normalizeUrl(item?.url);
    if (!url || map.has(url)) continue;
    map.set(url, { url, isCustom: Boolean(item.isCustom), latency: null, status: undefined, error: null });
  }
  return [...map.values()];
}

export function openProviderModal({
  connection = null,
  activeGroup = 'claude',
  onSave,
  onTest,
  onFetchModels,
}) {
  if (activeDialog) {
    activeDialog.remove();
    activeDialog = null;
  }

  const isOfficial = Boolean(connection?.id?.startsWith('official-'));
  const isEdit = Boolean(connection?.id);
  const conn = seedOfficialConfig(connection ? JSON.parse(JSON.stringify(connection)) : {
    name: '',
    baseUrl: '',
    protocol: defaultProtocolForGroup(activeGroup),
    modelGroups: [activeGroup],
    modelConfigs: {},
  }, activeGroup);
  conn.models = Array.isArray(conn.models) ? conn.models : [];

  const presets = isOfficial ? [] : getPresets(activeGroup);
  let selectedPresetId = conn.presetId || 'custom';
  let sortMode = 'original';
  let searchQuery = '';
  let endpoints = uniqueEndpoints([
    ...(conn.endpointCandidates || []).map(url => ({ url, isCustom: false })),
    ...(conn.customEndpoints || []).map(url => ({ url, isCustom: true })),
    conn.baseUrl ? { url: conn.baseUrl, isCustom: Boolean(conn.id) } : null,
  ].filter(Boolean));
  let autoSelectFastest = true;

  const d = document.createElement('dialog');
  d.id = 'cc-provider-dialog';
  d.className = 'cc-dialog';

  function presetChip(p, selected) {
    const label = CATEGORY_LABELS[p.category] || '其他';
    const mark = p.primePartner
      ? `<span class="cc-partner-heart" aria-hidden="true">${icons.heart}</span>`
      : p.isPartner
        ? `<span class="cc-partner-star" aria-hidden="true">${icons.star}</span>`
        : '';
    const theme = selected && p.theme?.backgroundColor
      ? ` style="background:${esc(p.theme.backgroundColor)};color:${esc(p.theme.textColor || '#fff')};border-color:transparent"`
      : '';
    return `
      <button type="button" class="cc-preset-chip ${selected ? 'selected' : ''}" data-preset-id="${esc(p.id)}" title="${esc(label)}"${theme}>
        ${iconImg(p.icon, p.iconColor, 'cc-preset-icon') || '<span class="cc-preset-icon-placeholder" aria-hidden="true"></span>'}
        <span class="cc-preset-name">${esc(p.name)}</span>
        ${mark}
      </button>`;
  }

  const groupName = MODEL_GROUPS.find(g => g.id === activeGroup)?.name || activeGroup;
  const dialogTitle = isOfficial ? '配置官方模型' : isEdit ? '编辑供应商' : `添加 ${groupName} 供应商`;
  const dialogSub = isOfficial
    ? '为官方登录配置默认模型、努力程度、上下文与模型列表'
    : isEdit
      ? '修改接口配置与模型列表'
      : '选择预设模板或自定义配置模型接口';
  const saveLabel = isOfficial ? '保存模型配置' : isEdit ? '保存供应商' : '添加';

  d.innerHTML = `
    <div class="cc-dialog-panel">
      <div class="cc-dialog-header">
        <button type="button" class="cc-dialog-back" data-dialog-close aria-label="关闭">${icons.back}</button>
        <div class="cc-dialog-heading">
          <h2>${esc(dialogTitle)}</h2>
          <span class="muted">${esc(dialogSub)}</span>
        </div>
      </div>

      <div class="cc-dialog-body">
        ${!isOfficial && !isEdit && presets.length ? `
          <div class="cc-preset-section">
            <div class="cc-preset-toolbar">
              <label class="cc-section-label">预设供应商</label>
              <div class="cc-preset-tools">
                <input class="cc-preset-search" data-preset-search type="search" placeholder="搜索名称、官网或分类..." hidden aria-label="搜索预设供应商">
                <button type="button" class="cc-icon-tool" data-preset-search-toggle title="搜索预设 (Ctrl+F)" aria-label="搜索预设供应商" aria-pressed="false">${icons.search}</button>
                <button type="button" class="cc-icon-tool" data-preset-sort title="按名称 A-Z 排序" aria-label="切换预设排序" aria-pressed="false">${icons.sort}</button>
              </div>
            </div>
            <div class="cc-preset-grid" data-preset-grid></div>
            <p class="muted cc-preset-hint" data-preset-hint></p>
          </div>
        ` : ''}

        <form id="cc-provider-form" class="cc-provider-form" novalidate>
          <p class="muted cc-provider-scope">${isOfficial ? '模型配置仅作用于该官方登录。' : `此供应商属于 ${esc(groupName)} 分组，模型配置也仅作用于该分组。`}</p>

          ${isOfficial ? '' : `
          <div class="cc-icon-row">
            <button type="button" class="cc-icon-btn" data-pick-icon title="点击更换图标">
              <span data-icon-preview>${iconImg(conn.icon, conn.iconColor, 'cc-icon-preview') || icons.generic}</span>
            </button>
          </div>
          <input type="hidden" name="icon" value="${esc(conn.icon || '')}">
          <input type="hidden" name="iconColor" value="${esc(conn.iconColor || '')}">
          <input type="hidden" name="iconFile" value="${esc(conn.iconFile || '')}">
          <input type="hidden" name="presetId" value="${esc(conn.presetId || '')}">
          <input type="hidden" name="apiKeyUrl" value="${esc(conn.apiKeyUrl || '')}">
          <input type="hidden" name="modelsUrl" value="${esc(conn.modelsUrl || '')}">
          <input type="hidden" name="isPartner" value="${conn.isPartner ? '1' : ''}">
          <input type="hidden" name="primePartner" value="${conn.primePartner ? '1' : ''}">
          <input type="hidden" name="partnerPromotionKey" value="${esc(conn.partnerPromotionKey || '')}">
          <input type="hidden" name="category" value="${esc(conn.category || '')}">
          <input type="hidden" name="endpointCandidates" value="${esc(JSON.stringify(conn.endpointCandidates || []))}">
          <input type="hidden" name="customEndpoints" value="${esc(JSON.stringify(conn.customEndpoints || []))}">

          <div class="cc-form-row">
            <label>
              供应商名称 <span class="required">*</span>
              <input name="name" required value="${esc(conn.name)}" placeholder="例如：我的模型服务">
            </label>
            <label>
              备注
              <input name="notes" value="${esc(conn.notes || '')}" placeholder="显示在供应商卡片上">
            </label>
          </div>

          <label>
            官网地址
            <input name="websiteUrl" type="url" value="${esc(conn.websiteUrl || '')}" placeholder="https://example.com">
          </label>

          <label>
            接口协议 <span class="required">*</span>
            <select name="protocol">
              ${protocolSelectOptions().map(o => `<option value="${esc(o.value)}" ${conn.protocol === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
            </select>
            <small class="muted">${PROTOCOL_HINT}</small>
          </label>

          <label>
            API 密钥 (API Key)
            <div class="cc-password-row">
              <input name="key" type="password" autocomplete="new-password" placeholder="${conn.hasKey ? '已加密保存，留空保留原有密钥' : '输入 API Key，将自动填充到配置'}">
              <button type="button" class="cc-eye-btn" data-toggle-key aria-label="显示或隐藏密钥">${icons.eye}</button>
            </div>
            <div class="cc-key-extras" data-key-extras></div>
            <small class="muted">密钥使用 Windows DPAPI 当前用户硬件级加密保存，绝不明文存盘。</small>
          </label>

          <div class="cc-endpoint-wrap">
            <div class="cc-endpoint-label-row">
              <span>API 基础地址 (Base URL) <span class="required">*</span></span>
              <button type="button" class="cc-endpoint-manage" data-toggle-endpoints>${icons.zap} 管理和测速</button>
            </div>
            <input name="baseUrl" type="url" required value="${esc(conn.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off">
            <div class="cc-endpoint-panel" data-endpoint-panel hidden>
              <div class="cc-endpoint-add">
                <input data-endpoint-new placeholder="https://api.example.com/v1" autocomplete="off">
                <button type="button" data-endpoint-add>添加</button>
              </div>
              <p class="cc-endpoint-error" data-endpoint-error hidden></p>
              <div class="cc-endpoint-list" data-endpoint-list></div>
              <div class="cc-endpoint-actions">
                <label class="cc-endpoint-auto"><input type="checkbox" data-endpoint-auto checked> 自动选择最快</label>
                <button type="button" class="secondary" data-endpoint-test>开始测速</button>
              </div>
            </div>
          </div>
          `}

          <div id="cc-modal-model-config" class="cc-modal-model-config">
            ${modelConfigFields(conn, activeGroup)}
          </div>
        </form>
      </div>

      <div class="cc-dialog-footer">
        <div class="cc-footer-right">
          <button type="button" class="secondary" data-dialog-close>取消</button>
          <button type="button" class="primary cc-save-btn" data-dialog-action="save">${isEdit || isOfficial ? '' : icons.plus}${esc(saveLabel)}</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(d);
  activeDialog = d;

  const form = d.querySelector('#cc-provider-form');
  const close = () => { d.close(); d.remove(); activeDialog = null; };

  d.querySelectorAll('[data-dialog-close]').forEach(b => b.onclick = close);
  d.onclose = () => { d.remove(); activeDialog = null; };

  const keyInput = form.querySelector('[name=key]');
  const eyeBtn = form.querySelector('[data-toggle-key]');
  if (eyeBtn && keyInput) {
    eyeBtn.onclick = () => {
      const isPassword = keyInput.type === 'password';
      keyInput.type = isPassword ? 'text' : 'password';
      eyeBtn.innerHTML = isPassword ? icons.eyeOff : icons.eye;
    };
  }

  function closeFloating() {
    d.querySelectorAll('.effort-menu').forEach(menu => { menu.hidden = true; });
    d.querySelector('.model-picker-menu')?.remove();
  }

  function currentSuggestions() {
    const fetched = Object.values(conn.fetchedModels || {});
    const extra = fetched.length
      ? fetched.map(item => ({
          id: item.id,
          ownedBy: item.displayName && item.displayName !== item.id ? item.displayName : (item.ownedBy || '已拉取'),
        }))
      : (conn.models || []);
    return modelSuggestions(readModelConfig(form), extra);
  }

  function fillCatalogRowFromFetched(target, id) {
    const row = target.closest('[data-catalog-row]');
    if (!row) return;
    const meta = conn.fetchedModels?.[id] || {};
    const nameInput = row.querySelector('[data-map-name]');
    if (nameInput && !nameInput.value.trim()) nameInput.value = meta.displayName || id;
    const contextInput = row.querySelector('[data-map-context]');
    if (contextInput && !contextInput.value.trim() && meta.contextWindow) contextInput.value = meta.contextWindow;
  }

  function openModelPicker(anchor) {
    closeFloating();
    const target = anchor.dataset.field
      ? form.querySelector(`[name="${anchor.dataset.field}"]`)
      : anchor.closest('[data-catalog-row]')?.querySelector('[data-map-model]');
    if (!target) return;
    const suggestions = currentSuggestions();
    const menu = document.createElement('div');
    menu.className = 'model-picker-menu';
    menu.innerHTML = suggestions.length
      ? suggestions.map(m => `<button type="button" data-pick-id="${esc(m.id)}"><span>${esc(m.id)}</span><small>${esc(m.ownedBy || '')}</small></button>`).join('')
      : '<p class="muted">暂无建议，可手动填写或先拉取模型</p>';
    const rect = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.minWidth = `${Math.max(rect.width, 220)}px`;
    d.appendChild(menu);
    menu.addEventListener('click', e => {
      const pick = e.target.closest('[data-pick-id]');
      if (!pick) return;
      target.value = pick.dataset.pickId;
      fillCatalogRowFromFetched(target, pick.dataset.pickId);
      closeFloating();
      updateDefaultWarning(form);
    });
  }

  function syncEndpointFields() {
    const candidates = form.querySelector('[name=endpointCandidates]');
    const custom = form.querySelector('[name=customEndpoints]');
    if (candidates) candidates.value = JSON.stringify(endpoints.filter(item => !item.isCustom).map(item => item.url));
    if (custom) custom.value = JSON.stringify(endpoints.filter(item => item.isCustom).map(item => item.url));
  }

  function renderEndpointList() {
    const list = d.querySelector('[data-endpoint-list]');
    if (!list) return;
    const selected = normalizeUrl(form.querySelector('[name=baseUrl]')?.value);
    const rows = endpoints.slice().sort((a, b) => (a.latency ?? Infinity) - (b.latency ?? Infinity) || a.url.localeCompare(b.url));
    list.innerHTML = rows.length
      ? rows.map(item => {
        const latency = item.latency == null
          ? (item.error ? `<span class="cc-endpoint-fail">${esc(item.error)}</span>` : '<span class="muted">未测速</span>')
          : `<span class="cc-endpoint-ok">${item.latency}ms${item.status ? ` · ${item.status}` : ''}</span>`;
        return `<div class="cc-endpoint-row ${item.url === selected ? 'selected' : ''}" data-endpoint-url="${esc(item.url)}">
          <button type="button" class="cc-endpoint-pick" data-endpoint-select="${esc(item.url)}">${esc(item.url)}</button>
          ${latency}
          ${item.isCustom ? `<button type="button" class="cc-endpoint-remove" data-endpoint-remove="${esc(item.url)}" aria-label="删除端点">×</button>` : ''}
        </div>`;
      }).join('')
      : '<p class="muted">还没有可测速的地址，添加后可比较延迟。</p>';
  }

  function refreshIconButton() {
    const preview = d.querySelector('[data-icon-preview]');
    if (!preview) return;
    const icon = form.querySelector('[name=icon]')?.value;
    const color = form.querySelector('[name=iconColor]')?.value;
    preview.innerHTML = iconImg(icon, color, 'cc-icon-preview') || icons.generic;
  }

  function refreshKeyExtras() {
    const box = d.querySelector('[data-key-extras]');
    if (!box) return;
    const apiKeyUrl = form.querySelector('[name=apiKeyUrl]')?.value.trim();
    const websiteUrl = form.querySelector('[name=websiteUrl]')?.value.trim();
    const href = apiKeyUrl || websiteUrl;
    const promoKey = form.querySelector('[name=partnerPromotionKey]')?.value.trim();
    const promo = promoKey ? PARTNER_PROMOTIONS[promoKey] : '';
    box.innerHTML = [
      href ? `<a class="cc-get-key" href="${esc(href)}" target="_blank" rel="noopener noreferrer">获取 API Key</a>` : '',
      promo ? `<div class="cc-promo">💡 ${esc(promo)}</div>` : '',
    ].join('');
  }

  function syncProtocolSelect(select, value) {
    if (!select || !isValidProtocol(value)) return;
    select.value = value;
  }

  function applyPreset(p) {
    if (!p) return;
    selectedPresetId = p.id;
    form.querySelector('[name=presetId]').value = p.id;
    if (p.id !== 'custom') form.querySelector('[name=name]').value = p.name;
    if (p.protocol) syncProtocolSelect(form.querySelector('[name=protocol]'), p.protocol);
    form.querySelector('[name=baseUrl]').value = p.baseUrl || '';
    form.querySelector('[name=websiteUrl]').value = p.websiteUrl || '';
    form.querySelector('[name=icon]').value = p.icon || '';
    form.querySelector('[name=iconColor]').value = p.iconColor || '';
    form.querySelector('[name=iconFile]').value = p.iconFile || '';
    form.querySelector('[name=apiKeyUrl]').value = p.apiKeyUrl || '';
    form.querySelector('[name=modelsUrl]').value = p.modelsUrl || '';
    form.querySelector('[name=isPartner]').value = p.isPartner ? '1' : '';
    form.querySelector('[name=primePartner]').value = p.primePartner ? '1' : '';
    form.querySelector('[name=partnerPromotionKey]').value = p.partnerPromotionKey || '';
    form.querySelector('[name=category]').value = p.category || '';
    endpoints = uniqueEndpoints([
      ...(p.endpointCandidates || []).map(url => ({ url, isCustom: false })),
      p.baseUrl ? { url: p.baseUrl, isCustom: false } : null,
    ].filter(Boolean));
    syncEndpointFields();
    renderEndpointList();
    refreshIconButton();
    refreshKeyExtras();
    if (p.modelConfig) {
      const dummy = { modelConfigs: { [activeGroup]: p.modelConfig } };
      d.querySelector('#cc-modal-model-config').innerHTML = modelConfigFields(dummy, activeGroup);
    }
    renderPresetGrid();
  }

  function renderPresetGrid() {
    const grid = d.querySelector('[data-preset-grid]');
    if (!grid) return;
    const list = sortPresets(filterPresets(presets, searchQuery), sortMode);
    grid.innerHTML = list.length
      ? list.map(p => presetChip(p, p.id === selectedPresetId)).join('')
      : '<div class="cc-preset-empty">没有匹配的预设供应商。</div>';
    const hint = d.querySelector('[data-preset-hint]');
    const current = presets.find(p => p.id === selectedPresetId);
    if (hint) hint.textContent = categoryHint(current?.category);
    grid.querySelectorAll('[data-preset-id]').forEach(chip => {
      chip.onclick = () => {
        const p = presets.find(x => x.id === chip.dataset.presetId);
        applyPreset(p);
      };
    });
  }

  function uniqueIconEntries() {
    const seen = new Set();
    const out = [];
    for (const [name, file] of Object.entries(ICON_FILES)) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push({ name, file });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  function openIconPicker() {
    d.querySelector('.cc-icon-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'cc-icon-overlay';
    const entries = uniqueIconEntries();
    overlay.innerHTML = `
      <div class="cc-icon-picker">
        <div class="cc-icon-picker-head">
          <strong>选择图标</strong>
          <button type="button" class="icon-button" data-icon-close aria-label="关闭">×</button>
        </div>
        <input data-icon-filter type="search" placeholder="搜索图标" aria-label="搜索图标">
        <div class="cc-icon-grid" data-icon-grid>
          ${entries.map(item => `<button type="button" class="cc-icon-choice" data-icon-name="${esc(item.name)}" title="${esc(item.name)}"><img src="/icons/${esc(item.file)}" alt=""></button>`).join('')}
        </div>
      </div>`;
    d.querySelector('.cc-dialog-panel').appendChild(overlay);
    overlay.querySelector('[data-icon-close]').onclick = () => overlay.remove();
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.remove();
      const choice = e.target.closest('[data-icon-name]');
      if (!choice) return;
      form.querySelector('[name=icon]').value = choice.dataset.iconName;
      form.querySelector('[name=iconFile]').value = ICON_FILES[choice.dataset.iconName] || '';
      refreshIconButton();
      overlay.remove();
    });
    overlay.querySelector('[data-icon-filter]').oninput = e => {
      const q = e.target.value.trim().toLowerCase();
      overlay.querySelectorAll('[data-icon-name]').forEach(btn => {
        btn.hidden = q ? !btn.dataset.iconName.toLowerCase().includes(q) : false;
      });
    };
  }

  if (!isOfficial && !isEdit) {
    renderPresetGrid();
    if (!conn.name) {
      applyPreset(presets.find(p => p.id === selectedPresetId) || presets.find(p => p.id === 'custom'));
    } else {
      refreshKeyExtras();
      renderEndpointList();
    }
  } else {
    refreshKeyExtras();
    renderEndpointList();
  }

  const searchInput = d.querySelector('[data-preset-search]');
  const searchToggle = d.querySelector('[data-preset-search-toggle]');
  const sortToggle = d.querySelector('[data-preset-sort]');
  function setSearchOpen(open) {
    if (!searchInput) return;
    searchInput.hidden = !open;
    searchToggle?.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (!open) {
      searchQuery = '';
      searchInput.value = '';
      renderPresetGrid();
    } else searchInput.focus();
  }
  searchToggle?.addEventListener('click', () => {
    setSearchOpen(Boolean(searchInput?.hidden));
  });
  searchInput?.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderPresetGrid();
  });
  searchInput?.addEventListener('keydown', e => {
    if (e.key === 'Escape') setSearchOpen(false);
  });
  sortToggle?.addEventListener('click', () => {
    sortMode = sortMode === 'original' ? 'nameAsc' : 'original';
    sortToggle.classList.toggle('active', sortMode === 'nameAsc');
    sortToggle.setAttribute('aria-pressed', sortMode === 'nameAsc' ? 'true' : 'false');
    sortToggle.title = sortMode === 'nameAsc' ? '恢复原始顺序' : '按名称 A-Z 排序';
    renderPresetGrid();
  });
  d.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !isOfficial && !isEdit) {
      e.preventDefault();
      e.stopPropagation();
      setSearchOpen(true);
    }
  }, true);
  d.addEventListener('mousedown', e => {
    if (!searchInput || searchInput.hidden) return;
    if (!d.querySelector('.cc-preset-section')?.contains(e.target)) setSearchOpen(false);
  });

  d.querySelector('[data-pick-icon]')?.addEventListener('click', openIconPicker);
  form.querySelector('[name=websiteUrl]')?.addEventListener('input', refreshKeyExtras);
  d.querySelector('[data-toggle-endpoints]')?.addEventListener('click', () => {
    const panel = d.querySelector('[data-endpoint-panel]');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderEndpointList();
  });
  d.querySelector('[data-endpoint-add]')?.addEventListener('click', () => {
    const input = d.querySelector('[data-endpoint-new]');
    const errorBox = d.querySelector('[data-endpoint-error]');
    const raw = input?.value.trim() || '';
    let message = '';
    if (!raw) message = '请输入有效地址';
    else {
      try {
        const parsed = new URL(raw);
        if (!['http:', 'https:'].includes(parsed.protocol)) message = '仅支持 HTTP/HTTPS 地址';
        const sanitized = normalizeUrl(parsed.toString());
        if (!message && endpoints.some(item => item.url === sanitized)) message = '该地址已存在';
        if (!message) {
          endpoints.push({ url: sanitized, isCustom: true, latency: null, status: undefined, error: null });
          if (!form.querySelector('[name=baseUrl]').value.trim()) form.querySelector('[name=baseUrl]').value = sanitized;
          input.value = '';
          syncEndpointFields();
          renderEndpointList();
        }
      } catch {
        message = '地址格式无效';
      }
    }
    if (errorBox) {
      errorBox.hidden = !message;
      errorBox.textContent = message;
    }
    if (message) notice(message, 'error');
  });
  d.querySelector('[data-endpoint-auto]')?.addEventListener('change', e => {
    autoSelectFastest = e.target.checked;
  });
  d.querySelector('[data-endpoint-list]')?.addEventListener('click', e => {
    const select = e.target.closest('[data-endpoint-select]');
    if (select) {
      form.querySelector('[name=baseUrl]').value = select.dataset.endpointSelect;
      renderEndpointList();
      return;
    }
    const remove = e.target.closest('[data-endpoint-remove]');
    if (remove) {
      endpoints = endpoints.filter(item => item.url !== remove.dataset.endpointRemove);
      if (normalizeUrl(form.querySelector('[name=baseUrl]').value) === remove.dataset.endpointRemove) {
        form.querySelector('[name=baseUrl]').value = endpoints[0]?.url || '';
      }
      syncEndpointFields();
      renderEndpointList();
    }
  });
  d.querySelector('[data-endpoint-test]')?.addEventListener('click', async () => {
    const btn = d.querySelector('[data-endpoint-test]');
    const errorBox = d.querySelector('[data-endpoint-error]');
    const urls = endpoints.map(item => item.url);
    if (!urls.length) {
      if (errorBox) { errorBox.hidden = false; errorBox.textContent = '请先添加端点'; }
      notice('请先添加端点', 'warning');
      return;
    }
    btn.disabled = true;
    try {
      const r = await fetch('/api/endpoints/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, timeoutSecs: ENDPOINT_TIMEOUT[activeGroup] || 8 }),
      });
      const payload = await r.json();
      if (!r.ok) throw new Error(payload.error || '测速失败');
      const map = new Map((payload.results || []).map(item => [normalizeUrl(item.url), item]));
      endpoints = endpoints.map(item => {
        const match = map.get(item.url);
        return {
          ...item,
          latency: typeof match?.latency === 'number' ? Math.round(match.latency) : null,
          status: match?.status,
          error: match?.error || null,
        };
      });
      if (autoSelectFastest) {
        const best = endpoints.filter(item => item.latency != null).sort((a, b) => a.latency - b.latency)[0];
        if (best) form.querySelector('[name=baseUrl]').value = best.url;
      }
      if (errorBox) errorBox.hidden = true;
      renderEndpointList();
    } catch (err) {
      if (errorBox) { errorBox.hidden = false; errorBox.textContent = err.message; }
      notice(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  d.addEventListener('click', e => {
    const probeBtn = e.target.closest('[data-dialog-action="test"], [data-dialog-action="fetch-models"]');
    if (probeBtn && d.contains(probeBtn)) {
      e.preventDefault();
      if (probeBtn.dataset.dialogAction === 'test') runHiTest(probeBtn);
      else runFetchModels(probeBtn);
      return;
    }
    const pickBtn = e.target.closest('[data-action]');
    if (pickBtn && d.contains(pickBtn)) {
      const action = pickBtn.dataset.action;
      if (['add-model-row', 'remove-model-row', 'add-default-row', 'pick-model', 'toggle-effort-menu'].includes(action)) {
        e.preventDefault();
        e.stopPropagation();
        if (action === 'add-model-row') {
          closeFloating();
          const rows = form.querySelector('[data-catalog-rows]');
          if (rows) rows.insertAdjacentHTML('beforeend', catalogRow());
        } else if (action === 'remove-model-row') {
          closeFloating();
          pickBtn.closest('[data-catalog-row]')?.remove();
          updateDefaultWarning(form);
        } else if (action === 'add-default-row') {
          closeFloating();
          const config = readModelConfig(form);
          const rows = form.querySelector('[data-catalog-rows]');
          if (rows && config.defaultModel) {
            rows.insertAdjacentHTML('beforeend', catalogRow({
              model: config.defaultModel,
              displayName: config.defaultModel,
              contextWindow: config.contextWindow,
              reasoningLevels: config.defaultEffort ? [config.defaultEffort] : [],
              defaultReasoningLevel: config.defaultEffort || '',
            }));
            updateDefaultWarning(form);
          }
        } else if (action === 'pick-model') {
          openModelPicker(pickBtn);
        } else if (action === 'toggle-effort-menu') {
          const menu = pickBtn.closest('.effort-picker')?.querySelector('.effort-menu');
          const wasHidden = menu?.hidden;
          closeFloating();
          if (menu && wasHidden) {
            menu.hidden = false;
            syncEffortPicker(pickBtn.closest('.effort-picker'));
          }
        }
        return;
      }
    }
    if (!e.target.closest('.effort-picker') && !e.target.closest('.model-picker-menu') && !e.target.closest('[data-action="pick-model"]')) {
      closeFloating();
    }
  });

  d.addEventListener('change', e => {
    if (e.target.matches('[data-map-level]')) syncEffortPicker(e.target.closest('.effort-picker'));
  });
  d.addEventListener('input', e => {
    if (e.target.matches('[name=defaultModel], [data-map-model]')) updateDefaultWarning(form);
  });

  d.querySelector('[data-dialog-action=save]').onclick = async () => {
    const submitBtn = d.querySelector('[data-dialog-action=save]');
    submitBtn.disabled = true;
    try {
      const modelConfig = readModelConfig(form);
      const payload = {
        id: conn.id,
        modelGroups: [activeGroup],
        modelConfigs: {
          ...(conn.modelConfigs || {}),
          [activeGroup]: modelConfig,
        },
      };
      if (!isOfficial) {
        const name = form.querySelector('[name=name]').value.trim();
        const baseUrl = form.querySelector('[name=baseUrl]').value.trim();
        const protocol = form.querySelector('[name=protocol]').value;
        const key = form.querySelector('[name=key]').value.trim();
        if (!name) throw new Error('请输入供应商名称');
        if (!baseUrl) throw new Error('请输入 API 基础地址');
        payload.name = name;
        payload.baseUrl = baseUrl;
        payload.protocol = protocol;
        payload.notes = form.querySelector('[name=notes]').value.trim();
        payload.websiteUrl = form.querySelector('[name=websiteUrl]').value.trim();
        payload.icon = form.querySelector('[name=icon]').value.trim();
        payload.iconColor = form.querySelector('[name=iconColor]').value.trim();
        payload.iconFile = form.querySelector('[name=iconFile]').value.trim();
        payload.presetId = form.querySelector('[name=presetId]').value.trim();
        payload.apiKeyUrl = form.querySelector('[name=apiKeyUrl]').value.trim();
        payload.modelsUrl = form.querySelector('[name=modelsUrl]').value.trim();
        payload.isPartner = Boolean(form.querySelector('[name=isPartner]').value);
        payload.primePartner = Boolean(form.querySelector('[name=primePartner]').value);
        payload.partnerPromotionKey = form.querySelector('[name=partnerPromotionKey]').value.trim();
        payload.category = form.querySelector('[name=category]').value.trim();
        try { payload.endpointCandidates = JSON.parse(form.querySelector('[name=endpointCandidates]').value || '[]'); } catch { payload.endpointCandidates = []; }
        try { payload.customEndpoints = JSON.parse(form.querySelector('[name=customEndpoints]').value || '[]'); } catch { payload.customEndpoints = []; }
        if (key) payload.key = key;
      }
      await onSave(payload);
      close();
    } catch (err) {
      notice(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
    }
  };

  async function runHiTest(testBtn) {
    if (!testBtn || testBtn.disabled) return;
    testBtn.disabled = true;
    notice('正在向模型发送 hi…', 'info');
    try {
      const res = await onTest({
        id: conn.id,
        baseUrl: form.querySelector('[name=baseUrl]')?.value.trim(),
        protocol: form.querySelector('[name=protocol]')?.value,
        key: form.querySelector('[name=key]')?.value.trim(),
        modelConfig: readModelConfig(form),
      });
      const preview = res?.preview ? `；返回：${res.preview}` : '；模型已响应';
      notice(`✓ 已发送 hi，耗时 ${res?.durationMs ?? 0}ms${preview}`, 'success');
    } catch (err) {
      notice(`✕ 发送 hi 未通过：${err.message}`, 'error');
    } finally {
      testBtn.disabled = false;
    }
  }

  function fetchedEntries(payload) {
    if (Array.isArray(payload?.catalog) && payload.catalog.length) {
      return payload.catalog.map(item => {
        const id = typeof item === 'string' ? item : (item?.id || item?.model || '');
        return id ? { ...(typeof item === 'object' ? item : {}), id } : null;
      }).filter(Boolean);
    }
    return (payload?.models || []).map(id => (typeof id === 'string' ? { id } : id)).filter(item => item?.id);
  }

  function applyFetchedCatalog(payload) {
    const fetched = fetchedEntries(payload).slice(0, 200);
    conn.models = fetched.map(item => item.id);
    conn.fetchedModels = Object.fromEntries(fetched.map(item => [item.id, item]));
  }

  async function runFetchModels(fetchBtn) {
    if (!fetchBtn || fetchBtn.disabled) return;
    fetchBtn.disabled = true;
    notice(isOfficial ? '正在从官方账号拉取模型列表…' : '正在向供应商接口探测模型列表…', 'info');
    try {
      const r = await onFetchModels({
        id: conn.id,
        baseUrl: form.querySelector('[name=baseUrl]')?.value.trim(),
        protocol: form.querySelector('[name=protocol]')?.value,
        key: form.querySelector('[name=key]')?.value.trim(),
        modelsUrl: form.querySelector('[name=modelsUrl]')?.value.trim(),
      });
      applyFetchedCatalog(r);
      if (!conn.models.length) throw new Error('接口未返回模型列表，可手动填写模型标识');
      notice(`✓ 已拉取 ${conn.models.length} 个模型，请自行添加到列表`, 'success');
    } catch (err) {
      notice(`✕ 拉取失败：${err.message}`, 'error');
    } finally {
      fetchBtn.disabled = false;
    }
  }

  d.showModal();
}
