import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseFrontmatter(raw) {
  const text = String(raw || '');
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const head = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\s+/, '');
  const meta = {};
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    meta[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { meta, body };
}

function readSkillDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const skillFile = entry.isDirectory()
      ? path.join(dir, entry.name, 'SKILL.md')
      : entry.name.toLowerCase() === 'skill.md' ? path.join(dir, entry.name) : '';
    if (!skillFile || !fs.existsSync(skillFile)) continue;
    try {
      const { meta, body } = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
      const name = meta.name || (entry.isDirectory() ? entry.name : path.basename(path.dirname(skillFile)));
      out.push({
        name,
        description: meta.description || '',
        body,
        filePath: skillFile,
      });
    } catch { /* skip broken skill */ }
  }
  return out;
}

export function skillDirs(vendor, workspace) {
  const home = os.homedir();
  if (vendor === 'agy') {
    return [
      path.join(home, '.gemini', 'antigravity-cli', 'builtin', 'skills'),
      path.join(home, '.gemini', 'antigravity-cli', 'skills'),
      path.join(workspace, '.agents', 'skills'),
    ];
  }
  if (vendor === 'claude') {
    return [
      path.join(workspace, '.claude', 'skills'),
      path.join(home, '.claude', 'skills'),
    ];
  }
  if (vendor === 'codex') {
    return [
      path.join(workspace, '.codex', 'skills'),
      path.join(home, '.codex', 'skills'),
    ];
  }
  if (vendor === 'grok') {
    return [
      path.join(home, '.grok', 'bundled', 'skills'),
      path.join(workspace, '.grok', 'skills'),
      path.join(home, '.grok', 'skills'),
    ];
  }
  return [path.join(workspace, '.agents', 'skills')];
}

export function loadSkills(vendor, workspace) {
  const seen = new Map();
  for (const dir of skillDirs(vendor, workspace)) {
    for (const skill of readSkillDir(dir)) {
      seen.set(skill.name, skill);
    }
  }
  return [...seen.values()];
}

export function skillCatalogText(skills) {
  if (!skills.length) return 'No skills mounted.';
  return skills.map(s => `- ${s.name}: ${s.description || '(no description)'}`).join('\n');
}

const RULE_NAMES = {
  agy: ['GEMINI.md', 'AGENTS.md'],
  claude: ['CLAUDE.md', 'AGENTS.md'],
  grok: ['AGENTS.md'],
  codex: ['AGENTS.md'],
  custom: ['AGENTS.md'],
};

export function loadRules(vendor, workspace) {
  const names = RULE_NAMES[vendor] || RULE_NAMES.custom;
  const chunks = [];
  let dir = path.resolve(workspace);
  const home = os.homedir();
  for (let i = 0; i < 4; i += 1) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        try {
          const text = fs.readFileSync(file, 'utf8').trim();
          if (text) chunks.push({ file, text: text.slice(0, 20000) });
        } catch { /* skip */ }
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir.toLowerCase() === home.toLowerCase()) break;
    dir = parent;
  }
  return chunks;
}

const HARNESS_BY_FAMILY = { agy: 'gemini', claude: 'claude', grok: 'grok', codex: 'codex' };

export function environmentBlock({ workspace, timezone, vendor, mode, osName = process.platform, model, managerIdle, toolFamily } = {}) {
  const now = new Date().toISOString();
  const harness = managerIdle
    ? (HARNESS_BY_FAMILY[toolFamily] || toolFamily || vendor)
    : vendor;
  return [
    `Workspace: ${workspace}`,
    `OS: ${osName}`,
    `Timezone (session): ${timezone || '(none)'}`,
    `Vendor harness: ${harness}`,
    model ? `Model: ${model}` : '',
    `Permission mode: ${mode}`,
    `Now: ${now}`,
  ].filter(Boolean).join('\n');
}
