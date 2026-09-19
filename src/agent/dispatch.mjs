import { preferredConnectionModel } from '../../public/model-selection.js';
import { MODEL_GROUPS, connectionGroups } from '../../public/model-groups.js';
import {
  clonePartitions,
  createExecutionPartition,
  findIdleExecution,
  takeCloneSlot,
  workerPartitions,
  MAX_MANAGER_CLONES,
} from '../core.mjs';
import { groupLabel, pickFamily, pickVendor, vendorLabel } from './loop.mjs';

function hydrateConnection(connection, state) {
  if (!connection) return connection;
  const official = state.officialModelConfigs?.[connection.id];
  if (!official) return connection;
  return { ...connection, modelConfigs: { ...official, ...(connection.modelConfigs || {}) } };
}

export function capabilityPool(state, statuses, hasSecret) {
  const pool = [];
  const seen = new Set();
  const add = (connection, kind) => {
    if (!connection?.id || seen.has(connection.id)) return;
    const hydrated = hydrateConnection(connection, state);
    const vendor = pickVendor(hydrated);
    const family = pickFamily(hydrated);
    const groups = connectionGroups(hydrated);
    const groupId = groups[0] || '';
    const series = groupLabel(hydrated);
    const model = preferredConnectionModel(hydrated) || (hydrated.models || [])[0] || '';
    if (!model) return;
    seen.add(connection.id);
    const activeId = groupId ? state.activeProviders?.[groupId] : '';
    pool.push({
      connectionId: connection.id,
      name: connection.name || connection.id,
      kind,
      vendor: family,
      vendorLabel: series || (kind === 'custom' ? (connection.name || '自定义') : vendorLabel(vendor)),
      group: groupId,
      groupLabel: series,
      model: String(model),
      active: Boolean(activeId && activeId === connection.id),
    });
  };
  for (const c of statuses() || []) {
    if (c.connected && !c.expired) add(c, 'official');
  }
  for (const c of state.connections || []) {
    if (hasSecret(c.id)) add(c, 'custom');
  }
  return pool;
}

export function nextExecutionName(session, label) {
  const base = String(label || '执行').trim() || '执行';
  const names = new Set(workerPartitions(session).map(p => p.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

function needle(value) {
  return String(value || '').trim().toLowerCase();
}

function pickPreferred(list) {
  if (!list.length) return null;
  return list.find(p => p.active) || list[0];
}

function seriesOf(entry) {
  return needle(entry?.group || entry?.groupLabel || entry?.vendor || '');
}

export function preferActiveRoute(pool, connectionId) {
  const current = (pool || []).find(p => p.connectionId === connectionId);
  if (!current) return null;
  const series = seriesOf(current);
  if (!series) return current;
  const active = pool.find(p => p.active && seriesOf(p) === series);
  return active || current;
}

export function matchPoolEntry(pool, connectionId, prompt = '') {
  const id = needle(connectionId);
  if (id) {
    const byId = pool.filter(p => needle(p.connectionId) === id);
    if (byId.length) return pickPreferred(byId);
    const bySeries = pool.filter(p =>
      needle(p.groupLabel) === id
      || needle(p.vendorLabel) === id
      || needle(p.group) === id
      || needle(p.vendor) === id
    );
    if (bySeries.length) return pickPreferred(bySeries);
    const byName = pool.filter(p => needle(p.name) === id);
    if (byName.length) return pickPreferred(byName);
  }
  const text = needle(prompt);
  if (!text) return null;
  const seriesHits = pool.filter(p => {
    const labels = [p.vendorLabel, p.group, p.groupLabel, p.vendor].map(needle).filter(v => v.length >= 3);
    return labels.some(label => text.includes(label));
  });
  if (seriesHits.length) return pickPreferred(seriesHits);
  const ranked = [...pool].sort((a, b) => {
    const al = String(a.name || a.vendorLabel || '').length;
    const bl = String(b.name || b.vendorLabel || '').length;
    return bl - al;
  });
  for (const p of ranked) {
    const labels = [p.name, p.vendorLabel, p.vendor, p.group, p.groupLabel].map(needle).filter(v => v.length >= 3);
    if (labels.some(label => text.includes(label))) return p;
  }
  return null;
}

function poolHint(pool) {
  if (!pool.length) return '能力池为空';
  return `能力池：${pool.map(p => `${p.connectionId} · ${p.name}`).join('; ')}`;
}

export function resolveDispatchTarget({ session, state, statuses, hasSecret, connectionId, partitionId, model, busyIds, prompt }) {
  if (partitionId) {
    const part = workerPartitions(session).find(p => p.id === partitionId);
    if (!part) return { ok: false, error: '执行会话不存在' };
    if (busyIds.has(part.id)) return { ok: false, error: '该执行会话正在运行' };
    const route = (part.routes || [])[0] || {};
    const pool = capabilityPool(state, statuses, hasSecret);
    const picked = pool.find(p => p.connectionId === route.connectionId);
    return { ok: true, partition: part, reused: true, connectionId: route.connectionId, model: route.model, vendorLabel: picked?.vendorLabel };
  }
  const pool = capabilityPool(state, statuses, hasSecret);
  const picked = matchPoolEntry(pool, connectionId, prompt) || (!connectionId && pool.length === 1 ? pool[0] : null);
  if (!picked) return { ok: false, error: connectionId ? `能力池中没有该连接。${poolHint(pool)}` : `请指定 connectionId 或已有 partitionId。${poolHint(pool)}` };
  const resolvedModel = String(model || picked.model || '').trim();
  if (!resolvedModel) return { ok: false, error: '该连接没有可用模型' };
  const idle = findIdleExecution(session, {
    connectionId: picked.connectionId,
    model: resolvedModel,
    busyIds,
    name: picked.vendorLabel,
  });
  if (idle) {
    idle.routes = [{ connectionId: picked.connectionId, model: resolvedModel }];
    idle.key = String(resolvedModel || picked.connectionId).trim().toLowerCase();
    return { ok: true, partition: idle, reused: true, connectionId: picked.connectionId, model: resolvedModel, vendorLabel: picked.vendorLabel };
  }
  const partition = createExecutionPartition(session, {
    connectionId: picked.connectionId,
    model: resolvedModel,
    name: nextExecutionName(session, picked.vendorLabel),
  });
  return { ok: true, partition, reused: false, connectionId: picked.connectionId, model: resolvedModel, vendorLabel: picked.vendorLabel };
}

export function resolveCloneSlot({ session, connectionId, model, busyIds }) {
  return takeCloneSlot(session, { connectionId, model, busyIds });
}

export function cloneStatus(session, busyIds) {
  const running = clonePartitions(session).filter(p => busyIds.has(p.id)).length;
  return { running, max: MAX_MANAGER_CLONES, slots: clonePartitions(session).map(p => ({ id: p.id, name: p.name, slot: p.slot, running: busyIds.has(p.id) })) };
}
