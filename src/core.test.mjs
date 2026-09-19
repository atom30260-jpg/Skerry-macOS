import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attachModel,selectManager,ensureManagerPartition,isManagerPartition,isClonePartition,workerPartitions,createExecutionPartition,takeCloneSlot,visiblePartitions,freezeManager,managerPayloadForConnection,snapshotManagerSelection,groupOfConnection,MANAGER_PARTITION_NAME,MAX_MANAGER_CLONES} from './core.mjs';
test('同一模型跨官方和自定义供应商合并，重复添加不重复',()=>{const s={partitions:[]};attachModel(s,'official-codex','gpt-5');attachModel(s,'custom','gpt-5');attachModel(s,'custom','gpt-5');assert.equal(s.partitions.length,1);assert.equal(s.partitions[0].routes.length,2);});
test('新会话自动带管理者AI，不与工作分区合并，切换快照不影响原对象',()=>{
 const s={partitions:[]};
 const part=ensureManagerPartition(s);
 assert.equal(part.name,MANAGER_PARTITION_NAME);
 assert.equal(part.role,'manager');
 assert.equal(s.partitions.length,1);
 ensureManagerPartition(s);
 assert.equal(s.partitions.length,1);
 attachModel(s,'official-codex','gpt-5');
 attachModel(s,'official-codex','manager');
 assert.equal(s.partitions.filter(isManagerPartition).length,1);
 assert.equal(s.partitions[0].name,'管理者AI');
 assert.deepEqual(workerPartitions(s).map(p=>p.name).sort(),['gpt-5','manager']);
 const live={connectionId:'a',model:'m1',effort:'high'};
 const frozen=freezeManager(live);
 live.model='m2';
 assert.equal(frozen.model,'m1');
 assert.equal(freezeManager(null),null);
});
test('执行会话与分身分开，分身最多两个在跑且不进工人列表',()=>{
 const s={partitions:[]};
 ensureManagerPartition(s);
 const exec=createExecutionPartition(s,{connectionId:'official-grok',model:'grok-4',name:'Grok'});
 assert.equal(exec.role,'execution');
 assert.equal(workerPartitions(s).length,1);
 const first=takeCloneSlot(s,{connectionId:'official-grok',model:'grok-4',busyIds:new Set()});
 assert.equal(first.ok,true);
 assert.equal(isClonePartition(first.partition),true);
 assert.equal(workerPartitions(s).length,1);
 assert.equal(visiblePartitions(s).some(p=>p.role==='clone'),false);
 const busy=new Set([first.partition.id]);
 const second=takeCloneSlot(s,{connectionId:'official-grok',model:'grok-4',busyIds:busy});
 assert.equal(second.ok,true);
 busy.add(second.partition.id);
 const third=takeCloneSlot(s,{connectionId:'official-grok',model:'grok-4',busyIds:busy});
 assert.equal(third.ok,false);
 assert.equal(MAX_MANAGER_CLONES,2);
});
test('不同版本不合并，供应商别名可以显式归并',()=>{const s={partitions:[]};attachModel(s,'a','gpt-5');attachModel(s,'b','gpt-5.1');attachModel(s,'c','vendor/gpt-5','gpt-5');assert.equal(s.partitions.length,2);assert.equal(s.partitions[0].routes.length,2);});
test('会话相互隔离且空标识拒绝',()=>{const a={partitions:[]},b={partitions:[]};attachModel(a,'a','m');assert.equal(b.partitions.length,0);assert.throws(()=>attachModel(b,'b',' '));});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {saveSecret,loadSecret,deleteSecret,hasSecret} from './secret-store.mjs';
import {OAuthManager} from './oauth-manager.mjs';
test('Windows 密钥加密保存、读取与删除', {skip:process.platform!=='win32'},()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agents-secret-test-'));const env={MULTI_AGENT_SECRETS:dir};try{saveSecret('test','synthetic-test-secret',env);assert.equal(loadSecret('test',env),'synthetic-test-secret');assert.equal(fs.readFileSync(path.join(dir,'test.dpapi'),'utf8').includes('synthetic-test-secret'),false);deleteSecret('test',env);assert.equal(hasSecret('test',env),false);}finally{fs.rmdirSync(dir);}});
test('官方浏览器登录校验 state 并隐藏访问令牌',async()=>{let saved;const manager=new OAuthManager({hosts:{test:{flow:'browser',createAuthorizationUrl:async()=> 'https://example.com/auth',exchangeCode:async()=>({access_token:'synthetic-token'})}},saveToken:(id,t)=>{saved=t}});const started=await manager.start('test',{redirectUri:'http://localhost/callback'});await assert.rejects(()=>manager.callback('test',{code:'code',state:'invalid'}));assert.equal(manager.status('test').connected,false);const result=await manager.callback('test',{code:'code',state:started.state});assert.equal(saved.accessToken,'synthetic-token');assert.equal(manager.status('test').connected,true);assert.equal(JSON.stringify(result).includes('synthetic-token'),false);assert.equal(JSON.stringify(manager.status('test')).includes('synthetic-token'),false);manager.disconnect('test');assert.equal(manager.status('test').connected,false);});


test('管理者支持自定义和官方连接，只保存连接、模型、努力程度和上下文',()=>{const connections=[{id:'custom',hasKey:true},{id:'official',kind:'official',connected:true}];assert.deepEqual(selectManager(connections,{connectionId:'custom',model:' model-a ',key:'never-save'}),{connectionId:'custom',model:'model-a'});assert.deepEqual(selectManager(connections,{connectionId:'official',model:'model-b'}),{connectionId:'official',model:'model-b'});assert.deepEqual(selectManager(connections,{connectionId:'official',model:'model-b',effort:'High',contextWindow:'128000'}),{connectionId:'official',model:'model-b',effort:'high',contextWindow:128000});assert.throws(()=>selectManager(connections,{connectionId:'official',model:'model-b',effort:'turbo'}));});
test('管理者拒绝未配置、过期连接和空模型',()=>{assert.throws(()=>selectManager([{id:'a',hasKey:false}],{connectionId:'a',model:'m'}));assert.throws(()=>selectManager([{id:'a',kind:'official',connected:true,expired:true}],{connectionId:'a',model:'m'}));assert.throws(()=>selectManager([{id:'a',hasKey:true}],{connectionId:'a',model:' '}));});
test('管理者载荷跟系列上次选择走，型号不在目录时回落到默认',()=>{
 const grok={
  id:'custom-grok',
  hasKey:true,
  kind:'custom',
  modelGroups:['grok'],
  modelConfigs:{grok:{defaultModel:'grok-4.5',defaultEffort:'medium',contextWindow:200000,catalog:[
   {model:'grok-4.6',displayName:'Grok 4.6',contextWindow:200000,reasoningLevels:['low','medium','high','xhigh']},
   {model:'grok-4.5',displayName:'Grok 4.5',contextWindow:128000,reasoningLevels:['low','medium','high']},
  ]}},
 };
 assert.equal(groupOfConnection(grok),'grok');
 assert.deepEqual(
  managerPayloadForConnection(grok,'grok',{model:'grok-4.6',effort:'xhigh',contextWindow:200000}),
  {connectionId:'custom-grok',model:'grok-4.6',effort:'xhigh',contextWindow:200000}
 );
 const fallback=managerPayloadForConnection(grok,'grok',{model:'missing-model',effort:'xhigh',contextWindow:999});
 assert.equal(fallback.connectionId,'custom-grok');
 assert.equal(fallback.model,'grok-4.5');
 assert.equal(fallback.effort,undefined);
 assert.equal(fallback.contextWindow,999);
 assert.deepEqual(snapshotManagerSelection({connectionId:'x',model:'m',effort:'high',contextWindow:1}),{model:'m',effort:'high',contextWindow:1});
 assert.equal(snapshotManagerSelection({connectionId:'x'}),null);
});
