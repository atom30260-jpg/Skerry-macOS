import { connectionGroups } from '../public/model-groups.js';
import { normalizeReasoningLevel, normalizeContextWindow, connectionModelChoices, preferredConnectionModel, managerSelectionView } from '../public/model-selection.js';

export const MANAGER_PARTITION_KEY = 'manager';
export const MANAGER_PARTITION_NAME = '管理者AI';
export const MAX_MANAGER_CLONES = 2;

const identity = value => String(value || '').trim().toLowerCase();

export function isManagerPartition(partition) {
  if (!partition) return false;
  if (partition.role === 'manager') return true;
  return partition.key === MANAGER_PARTITION_KEY && partition.name === MANAGER_PARTITION_NAME;
}

export function isClonePartition(partition) {
  return partition?.role === 'clone';
}

export function isExecutionPartition(partition) {
  if (!partition || isManagerPartition(partition) || isClonePartition(partition)) return false;
  return partition.role === 'execution' || !partition.role;
}

export function workerPartitions(session) {
  return (session?.partitions || []).filter(isExecutionPartition);
}

export function clonePartitions(session) {
  return (session?.partitions || []).filter(isClonePartition);
}

export function visiblePartitions(session) {
  return (session?.partitions || []).filter(p => !isClonePartition(p));
}

export function createExecutionPartition(session, { connectionId, model, name }) {
  if (!Array.isArray(session.partitions)) session.partitions = [];
  const part = {
    id: crypto.randomUUID(),
    key: identity(model) || String(connectionId || 'execution'),
    name: String(name || model || '执行会话').trim(),
    role: 'execution',
    routes: [{ connectionId, model }],
  };
  session.partitions.push(part);
  return part;
}

export function findIdleExecution(session, { connectionId, model, busyIds = new Set(), name = '' }) {
  const workers = workerPartitions(session);
  const idle = p => !busyIds.has(p.id);
  const exact = workers.find(p => idle(p) && (p.routes || []).some(r => r.connectionId === connectionId && r.model === model));
  if (exact) return exact;
  const label = String(name || '').trim();
  if (!label) return null;
  return workers.find(p => idle(p) && p.name === label) || null;
}

export function takeCloneSlot(session, { connectionId, model, busyIds = new Set() }) {
  if (!Array.isArray(session.partitions)) session.partitions = [];
  const clones = clonePartitions(session);
  const running = clones.filter(p => busyIds.has(p.id));
  if (running.length >= MAX_MANAGER_CLONES) {
    return { ok: false, error: `管理者分身最多 ${MAX_MANAGER_CLONES} 个同时在跑` };
  }
  const idle = clones.find(p => !busyIds.has(p.id));
  if (idle) {
    idle.routes = [{ connectionId, model }];
    return { ok: true, partition: idle };
  }
  if (clones.length >= MAX_MANAGER_CLONES) {
    return { ok: false, error: `管理者分身最多 ${MAX_MANAGER_CLONES} 个同时在跑` };
  }
  const slot = clones.length + 1;
  const partition = {
    id: crypto.randomUUID(),
    key: `clone-${slot}`,
    name: `分身${slot}`,
    role: 'clone',
    slot,
    routes: [{ connectionId, model }],
  };
  session.partitions.push(partition);
  return { ok: true, partition };
}

export function ensureManagerPartition(session) {
  if (!Array.isArray(session.partitions)) session.partitions = [];
  let part = session.partitions.find(isManagerPartition);
  if (!part) {
    part = {
      id: crypto.randomUUID(),
      key: MANAGER_PARTITION_KEY,
      name: MANAGER_PARTITION_NAME,
      role: 'manager',
      routes: [],
    };
    session.partitions.unshift(part);
    return part;
  }
  part.role = 'manager';
  part.key = MANAGER_PARTITION_KEY;
  part.name = MANAGER_PARTITION_NAME;
  if (!Array.isArray(part.routes)) part.routes = [];
  const idx = session.partitions.indexOf(part);
  if (idx > 0) {
    session.partitions.splice(idx, 1);
    session.partitions.unshift(part);
  }
  return part;
}

export function attachModel(session, connectionId, model, canonical) {
  const key = identity(canonical || model);
  if (!key) throw new Error('请输入模型标识');
  if (!Array.isArray(session.partitions)) session.partitions = [];
  let partition = session.partitions.find(p => p.key === key && !isManagerPartition(p));
  if (!partition) { partition = { id: crypto.randomUUID(), key, name: String(canonical || model).trim(), routes: [] }; session.partitions.push(partition); }
  if (!partition.routes.some(r => r.connectionId === connectionId && r.model === model)) partition.routes.push({ connectionId, model });
  return partition;
}

export function freezeManager(manager) {
  if (!manager?.connectionId || !manager.model) return null;
  const frozen = { connectionId: manager.connectionId, model: manager.model };
  if (Object.prototype.hasOwnProperty.call(manager, 'effort')) frozen.effort = manager.effort || '';
  if (Object.prototype.hasOwnProperty.call(manager, 'contextWindow')) frozen.contextWindow = manager.contextWindow;
  return frozen;
}

export function selectManager(connections, input) {
  const connection=connections.find(c=>c.id===input.connectionId);
  if(!connection || (connection.kind==='official' ? !connection.connected || connection.expired : !connection.hasKey)) throw new Error('请先完成官方登录或保存供应商密钥');
  const model=String(input.model||'').trim();
  if(!model || model.length>200) throw new Error('请填写有效的模型标识（最多 200 字符）');
  const out={connectionId:connection.id,model};
  if(input.effort!==undefined&&input.effort!==null&&String(input.effort).trim()!==''){
    out.effort=normalizeReasoningLevel(input.effort);
  }
  if(input.contextWindow!==undefined&&input.contextWindow!==null&&String(input.contextWindow).trim()!==''){
    out.contextWindow=normalizeContextWindow(input.contextWindow);
  }
  return out;
}

export function groupOfConnection(connection) {
  if (!connection) return '';
  const groups = connectionGroups(connection);
  if (groups[0]) return groups[0];
  const official = String(connection.id || '');
  if (official === 'official-claude') return 'claude';
  if (official === 'official-codex') return 'codex';
  if (official === 'official-gemini') return 'gemini';
  if (official === 'official-grok') return 'grok';
  return '';
}

export function snapshotManagerSelection(manager) {
  if (!manager?.model) return null;
  const snap = { model: manager.model };
  if (manager.effort) snap.effort = manager.effort;
  if (manager.contextWindow !== undefined && manager.contextWindow !== '' && manager.contextWindow != null) {
    snap.contextWindow = manager.contextWindow;
  }
  return snap;
}

export function managerPayloadForConnection(connection, group, last) {
  if (!connection?.id) throw new Error('请先完成官方登录或保存供应商密钥');
  const groupId = group || groupOfConnection(connection);
  const choices = connectionModelChoices(connection, groupId);
  const lastModel = String(last?.model || '').trim();
  const preferred = preferredConnectionModel(connection, groupId);
  const model = lastModel && (!choices.length || choices.some(c => c.id === lastModel))
    ? lastModel
    : (preferred || lastModel);
  if (!model) throw new Error('请填写有效的模型标识（最多 200 字符）');
  const source = { connectionId: connection.id, model };
  if (last && Object.prototype.hasOwnProperty.call(last, 'effort')) source.effort = last.effort;
  if (last && Object.prototype.hasOwnProperty.call(last, 'contextWindow')) source.contextWindow = last.contextWindow;
  const view = managerSelectionView(connection, groupId, source);
  const out = { connectionId: connection.id, model: view.model || model };
  if (view.effort) out.effort = view.effort;
  if (view.contextWindow !== '' && view.contextWindow != null) out.contextWindow = view.contextWindow;
  return out;
}
