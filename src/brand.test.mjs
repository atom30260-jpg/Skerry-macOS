import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Skerry brand is used in user-facing shell metadata', () => {
  assert.match(read('public/index.html'), /<title>Skerry<\/title>/);
  assert.match(read('public/app.js'), /aria-label="Skerry 首页"/);
  assert.match(read('public/app.js'), /<span>Skerry<span class="brand-subtitle">WORKSPACE<\/span><\/span>/);
  assert.match(read('public/shell.js'), /settings-nav-footer">Skerry<\/div>/);
  assert.match(read('src-tauri/tauri.conf.json'), /"productName":"Skerry"/);
  assert.match(read('src-tauri/src/main.rs'), /title\("Skerry"\)/);
});

test('Skerry migration keeps internal compatibility identifiers', () => {
  assert.match(read('package.json'), /"name": "agents-gzt"/);
  assert.match(read('src-tauri/tauri.conf.json'), /"identifier":"com\.agentsgzt\.workbench"/);
  assert.match(read('public/icons/agents-gzt.svg'), /<title id="title">Skerry<\/title>/);
});
