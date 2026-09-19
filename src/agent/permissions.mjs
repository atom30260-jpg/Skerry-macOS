import {
  DEFAULT_MODE,
  VENDOR_MODES,
  cycleMode,
  describeMode,
  modeMenuTitle,
  modeOptions,
  normalizeMode,
} from '../../public/permission-modes.js';

export {
  DEFAULT_MODE,
  VENDOR_MODES,
  cycleMode,
  describeMode,
  modeMenuTitle,
  modeOptions,
  normalizeMode,
};

const READ = 'read';
const WRITE = 'write';
const EXEC = 'exec';
const NET = 'net';
const ASK = 'ask';
const NONE = 'none';

export function classifyRisk(kind) {
  return kind === READ || kind === NONE ? 'low' : kind === WRITE || kind === ASK ? 'medium' : 'high';
}

/**
 * @returns {{ action: 'allow'|'ask'|'deny', reason?: string }}
 */
export function decidePermission({ vendor, mode, kind, outsideWorkspace = false, planLocked = false }) {
  const m = normalizeMode(vendor, mode);
  if (outsideWorkspace && kind !== READ && kind !== NONE && kind !== ASK) {
    return { action: 'ask', reason: '工作区外路径需要额外授权' };
  }
  if (kind === NONE || kind === READ) return { action: 'allow' };
  if (kind === ASK) return { action: 'ask' };

  if (vendor === 'codex') {
    if (m === 'never') return { action: kind === EXEC ? 'allow' : 'allow' };
    if (m === 'on-failure') return { action: 'allow' };
    if (m === 'untrusted') return { action: kind === READ ? 'allow' : 'ask' };
    return { action: kind === READ ? 'allow' : 'ask' };
  }

  const bypass = m === 'bypassPermissions' || m === 'always-proceed';
  if (bypass) return { action: 'allow' };
  if (m === 'dontAsk') return { action: kind === READ || kind === NONE ? 'allow' : 'deny', reason: 'dontAsk 仅允许预批与只读' };
  if (m === 'plan' || planLocked) {
    if (kind === WRITE || kind === EXEC) return { action: 'deny', reason: 'plan 模式只读，先交出方案再改' };
    return { action: kind === NET ? 'ask' : 'allow' };
  }
  if (m === 'accept-edits' || m === 'acceptEdits') {
    if (kind === WRITE) return { action: 'allow' };
    if (kind === EXEC || kind === NET) return { action: 'ask' };
    return { action: 'allow' };
  }
  if (m === 'auto') return { action: kind === EXEC ? 'ask' : 'allow' };
  if (kind === WRITE || kind === EXEC || kind === NET) return { action: 'ask' };
  return { action: 'allow' };
}

export function planWritablePath(vendor, filePath) {
  if (vendor !== 'grok' && vendor !== 'claude') return false;
  return /(?:^|[\\/])plan\.md$/i.test(String(filePath || ''));
}
