import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkspacePath } from './workspace-io.mjs';

/** Codex apply_patch (Begin Patch / Add|Update|Delete File). */
export function applyPatch(workspace, patch, { allowOutside = false } = {}) {
  const text = String(patch || '').replace(/\r\n/g, '\n');
  if (!/\*\*\*\s*Begin Patch/.test(text)) return { ok: false, error: 'Missing *** Begin Patch' };
  const files = [];
  let current = null;
  const lines = text.split('\n');
  for (const line of lines) {
    const add = line.match(/^\*\*\*\s*Add File:\s*(.+)\s*$/);
    const update = line.match(/^\*\*\*\s*Update File:\s*(.+)\s*$/);
    const del = line.match(/^\*\*\*\s*Delete File:\s*(.+)\s*$/);
    if (add) { current = { op: 'add', file: add[1].trim(), body: [] }; files.push(current); continue; }
    if (update) { current = { op: 'update', file: update[1].trim(), body: [] }; files.push(current); continue; }
    if (del) { current = { op: 'delete', file: del[1].trim(), body: [] }; files.push(current); continue; }
    if (/^\*\*\*\s*(Begin Patch|End Patch)/.test(line) || line.startsWith('@@')) continue;
    if (current) current.body.push(line);
  }
  const changed = [];
  for (const item of files) {
    const { target } = resolveWorkspacePath(workspace, item.file, { allowOutside });
    if (item.op === 'delete') {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      changed.push({ op: 'delete', path: target });
      continue;
    }
    if (item.op === 'add') {
      const content = item.body.map(line => line.startsWith('+') ? line.slice(1) : line).join('\n');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
      changed.push({ op: 'add', path: target });
      continue;
    }
    const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const next = applyHunks(original, item.body);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next, 'utf8');
    changed.push({ op: 'update', path: target });
  }
  return { ok: true, changed };
}

function applyHunks(original, body) {
  let text = original;
  const hunks = [];
  let cur = { minus: [], plus: [] };
  const flush = () => {
    if (cur.minus.length || cur.plus.length) hunks.push(cur);
    cur = { minus: [], plus: [] };
  };
  for (const line of body) {
    if (line.startsWith('-')) cur.minus.push(line.slice(1));
    else if (line.startsWith('+')) cur.plus.push(line.slice(1));
    else if (line.startsWith(' ')) {
      cur.minus.push(line.slice(1));
      cur.plus.push(line.slice(1));
    } else if (line === '') {
      cur.minus.push('');
      cur.plus.push('');
    }
  }
  flush();
  for (const hunk of hunks) {
    const find = hunk.minus.join('\n');
    const replace = hunk.plus.join('\n');
    if (!find) {
      text = text ? `${text.replace(/\s*$/, '')}\n${replace}\n` : `${replace}\n`;
      continue;
    }
    if (!text.includes(find)) throw new Error(`apply_patch hunk not found:\n${find.slice(0, 200)}`);
    text = text.replace(find, replace);
  }
  return text;
}
