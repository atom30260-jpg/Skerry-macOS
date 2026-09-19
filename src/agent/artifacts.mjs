import fs from 'node:fs';
import path from 'node:path';

const OUTPUT_NAMES = new Set([
  'write', 'Write', 'search_replace', 'Edit', 'write_to_file',
  'replace_file_content', 'multi_replace_file_content', 'apply_patch',
  'NotebookEdit',
]);
const SOURCE_NAMES = new Set([
  'read_file', 'Read', 'view_file', 'grep', 'Grep', 'grep_search',
  'glob', 'Glob', 'find_by_name', 'list_dir', 'view_image',
]);

export function toolKind(name) {
  const n = String(name || '');
  if (OUTPUT_NAMES.has(n) || /^(write|replace|edit)/i.test(n) || /apply_patch/i.test(n)) return 'output';
  if (SOURCE_NAMES.has(n) || /^(read|view_file|grep|glob|find_by)/i.test(n) || n === 'list_dir') return 'source';
  return '';
}

export function toolPaths(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const out = [];
  const push = value => {
    const s = String(value || '').trim();
    if (s && s !== '.' && s !== '..') out.push(s);
  };
  push(a.path || a.file_path || a.filePath || a.target_file || a.TargetFile || a.AbsolutePath);
  if (String(name || '') === 'apply_patch') {
    const patch = String(a.patch || a.input || '');
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      push(match[1]);
    }
  }
  return [...new Set(out)];
}

export function artifactName(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function addArtifact(bucket, kind, filePath) {
  const key = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  if (!key || bucket.seen[kind].has(key)) return;
  bucket.seen[kind].add(key);
  bucket[kind === 'output' ? 'outputs' : 'sources'].push({
    path: filePath,
    name: artifactName(filePath),
  });
}

export function collectArtifactsFromMessages(messages, bucket) {
  const acc = bucket || { outputs: [], sources: [], seen: { output: new Set(), source: new Set() } };
  if (!acc.seen) acc.seen = { output: new Set(), source: new Set() };
  if (!acc.seen.output) acc.seen.output = new Set();
  if (!acc.seen.source) acc.seen.source = new Set();
  for (const message of messages || []) {
    for (const tc of message.toolCalls || []) {
      const kind = toolKind(tc.name);
      if (!kind) continue;
      for (const filePath of toolPaths(tc.name, tc.args)) addArtifact(acc, kind, filePath);
    }
  }
  return acc;
}

export function collectSessionArtifacts(dataDir, sessionId) {
  const bucket = { outputs: [], sources: [], seen: { output: new Set(), source: new Set() } };
  const id = String(sessionId || '');
  if (!id || !dataDir) return { outputs: bucket.outputs, sources: bucket.sources };
  const dir = path.join(dataDir, 'transcripts', id);
  if (!fs.existsSync(dir)) return { outputs: bucket.outputs, sources: bucket.sources };
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return { outputs: bucket.outputs, sources: bucket.sources }; }
  for (const name of files) {
    if (!name.endsWith('.json') || name === 'group.json') continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    collectArtifactsFromMessages(data.messages || [], bucket);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh');
  return {
    outputs: bucket.outputs.sort(byName),
    sources: bucket.sources.sort(byName),
  };
}
