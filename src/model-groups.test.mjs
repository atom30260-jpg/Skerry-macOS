import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MODEL_GROUPS,modelGroup,connectionGroups,connectionsInGroup,validateModelGroups} from '../public/model-groups.js';
test('按模型系列归类，多模型供应商可以跨组',()=>{assert.equal(modelGroup('vendor/claude-sonnet-4'),'claude');assert.equal(modelGroup('gpt-5'),'codex');assert.equal(modelGroup('grok-3'),'grok');assert.equal(modelGroup('gemini-2.5-pro'),'gemini');assert.deepEqual(connectionGroups({models:['gpt-5','claude-sonnet-4']}),['codex','claude']);});
test('官方与自定义连接在同一个模型系列中筛选',()=>{const list=[{id:'official-codex'},{id:'custom',modelGroups:['codex','claude']},{id:'official-claude'}];assert.deepEqual(connectionsInGroup(list,'codex').map(c=>c.id),['official-codex','custom']);});
test('旧数据只读推断，不使用兼容协议误判模型',()=>{const old={id:'custom',protocol:'openai',models:[]};assert.deepEqual(connectionGroups(old),[]);assert.equal(old.modelGroups,undefined);assert.deepEqual(connectionGroups({models:['gpt-5'],modelGroups:['claude']}),['claude']);});
test('拒绝无效分组并去重，不把不同模型版本误作独立系列',()=>{assert.throws(()=>validateModelGroups([]));assert.throws(()=>validateModelGroups(['fake']));assert.deepEqual(validateModelGroups(['claude','claude']),['claude']);assert.equal(modelGroup('gpt-5'),modelGroup('gpt-5.1'));});

test('仅保留四个分组，旧分组只读过滤且不影响有效归属',()=>{assert.deepEqual(MODEL_GROUPS.map(g=>g.name),['Claude','Codex','Gemini','Grok']);assert.deepEqual(connectionGroups({modelGroups:['kimi','codex','other']}),['codex']);assert.deepEqual(connectionGroups({modelGroups:['deepseek']}),[]);assert.throws(()=>validateModelGroups(['kimi']));assert.equal(modelGroup('kimi-k2'),null);});
