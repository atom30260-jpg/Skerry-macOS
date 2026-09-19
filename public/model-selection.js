// Adapted from CC Switch (MIT, Copyright 2025 Jason Young).
// Sources: ModelDropdown, CodexFormFields, useModelState. See licenses/CC-Switch-MIT.txt.
import {modelGroup} from './model-groups.js';
export const CLAUDE_FIELDS={model:'ANTHROPIC_MODEL',haiku:'ANTHROPIC_DEFAULT_HAIKU_MODEL',sonnet:'ANTHROPIC_DEFAULT_SONNET_MODEL',opus:'ANTHROPIC_DEFAULT_OPUS_MODEL',fable:'ANTHROPIC_DEFAULT_FABLE_MODEL',subagent:'CLAUDE_CODE_SUBAGENT_MODEL'};
export const hasClaudeOneMMarker=model=>String(model).trimEnd().toLowerCase().endsWith('[1m]');
export const stripClaudeOneMMarker=model=>hasClaudeOneMMarker(model)?String(model).trimEnd().slice(0,-4).trimEnd():String(model);
export function setClaudeOneMMarker(model,enabled){const base=stripClaudeOneMMarker(model).trim();return base?(enabled?`${base}[1M]`:base):'';}
export function parseClaudeModels(env={}){
 const value=key=>typeof env[key]==='string'?env[key]:'';
 const model=value('ANTHROPIC_MODEL'),small=value('ANTHROPIC_SMALL_FAST_MODEL');
 const has=key=>typeof env[key]==='string';
 const role=(key,fallback)=>has(key)?value(key):fallback;
 const haiku=role(CLAUDE_FIELDS.haiku,small||model),sonnet=role(CLAUDE_FIELDS.sonnet,model||small),opus=role(CLAUDE_FIELDS.opus,model||small),fable=role(CLAUDE_FIELDS.fable,opus);
 return {model,haiku,sonnet,opus,fable,subagent:value(CLAUDE_FIELDS.subagent)};
}
export function normalizeModels(models=[]){
 if(!Array.isArray(models))throw new Error('模型列表格式无效');
 const seen=new Set();
 return models.flatMap(m=>{const id=typeof m==='string'?m: m?.id; if(typeof id!=='string'||!id.trim()||seen.has(id.trim()))return [];seen.add(id.trim());return [{id:id.trim(),ownedBy:typeof m?.ownedBy==='string'?m.ownedBy:typeof m?.owned_by==='string'?m.owned_by:null}];});
}
export function modelSuggestions(config={},models=[]){
 const seen=new Set(),out=[];
 for(const row of config.catalog||[]){const id=row.model.trim();if(!id||seen.has(id))continue;seen.add(id);out.push({id,ownedBy:'模型列表'});}
 for(const m of normalizeModels(models)){if(!seen.has(m.id)){seen.add(m.id);out.push(m);}}
 return out;
}
export const REASONING_LEVELS=['none','minimal','low','medium','high','xhigh','max','ultra'];
export const REASONING_LABELS={none:'无',minimal:'最小',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最大',ultra:'超级'};
export const CATALOG_GROUPS=['codex','grok','gemini'];
export const usesModelCatalog=group=>CATALOG_GROUPS.includes(group);
const GROUP_IDS=['claude',...CATALOG_GROUPS];
const text=v=>{if(v===undefined||v===null)return '';if(typeof v!=='string'||v.length>300)throw new Error('模型配置字段格式无效');return v.trim();};
export function normalizeReasoningLevel(value){
 if(value===undefined||value===null||value==='')return '';
 if(typeof value!=='string'&&typeof value!=='number')throw new Error('努力程度格式无效');
 const level=String(value).trim().toLowerCase();
 if(!level)return '';
 if(!REASONING_LEVELS.includes(level))throw new Error('努力程度无效');
 return level;
}
export function normalizeReasoningLevels(list){
 if(list===undefined||list===null||list==='')return [];
 if(!Array.isArray(list))throw new Error('努力程度列表格式无效');
 const picked=new Set();
 for(const item of list){
  const level=normalizeReasoningLevel(item);
  if(level)picked.add(level);
 }
 return REASONING_LEVELS.filter(level=>picked.has(level));
}
export function normalizeContextWindow(value){
 if(value===undefined||value===null||value==='')return '';
 if(typeof value==='number'){
  if(!Number.isInteger(value)||value<1||value>16000000)throw new Error('上下文大小无效');
  return value;
 }
 if(typeof value!=='string')throw new Error('上下文大小格式无效');
 const trimmed=value.trim();
 if(!trimmed)return '';
 if(!/^\d+$/.test(trimmed))throw new Error('上下文大小必须是正整数');
 const n=Number(trimmed);
 if(n<1||n>16000000)throw new Error('上下文大小无效');
 return n;
}
export function normalizeCatalogRow(row={}){
 if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('模型列表格式无效');
 const model=text(row.model);
 if(!model)return null;
 const displayName=text(row.displayName);
 const contextWindow=normalizeContextWindow(row.contextWindow);
 const reasoningLevels=normalizeReasoningLevels(row.reasoningLevels);
 let defaultReasoningLevel=normalizeReasoningLevel(row.defaultReasoningLevel);
 if(defaultReasoningLevel&&reasoningLevels.length&&!reasoningLevels.includes(defaultReasoningLevel))defaultReasoningLevel='';
 const out={model,displayName};
 if(contextWindow!=='')out.contextWindow=contextWindow;
 if(reasoningLevels.length)out.reasoningLevels=reasoningLevels;
 if(defaultReasoningLevel)out.defaultReasoningLevel=defaultReasoningLevel;
 if(row.effortModels&&typeof row.effortModels==='object'&&!Array.isArray(row.effortModels)&&reasoningLevels.length){
  const effortModels={};
  for(const level of reasoningLevels){
   const id=text(row.effortModels[level]);
   if(id)effortModels[level]=id;
  }
  if(Object.keys(effortModels).length)out.effortModels=effortModels;
 }
 return out;
}
function withDefaults(result,input){
 const defaultEffort=normalizeReasoningLevel(input.defaultEffort);
 if(defaultEffort)result.defaultEffort=defaultEffort;
 const contextWindow=normalizeContextWindow(input.contextWindow);
 if(contextWindow!=='')result.contextWindow=contextWindow;
 return result;
}
export function normalizeModelConfig(group,input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('模型配置格式无效');
 if(group==='claude'){
  const env={};for(const key of Object.values(CLAUDE_FIELDS)){const val=text(input.env?.[key]);if(val)env[key]=val;}
  for(const role of ['HAIKU','SONNET','OPUS','FABLE']){const key=`ANTHROPIC_DEFAULT_${role}_MODEL_NAME`;const val=text(input.env?.[key]);if(val)env[key]=val;}
  return withDefaults({env},input);
 }
 const result=withDefaults({defaultModel:text(input.defaultModel)},input);
 if(usesModelCatalog(group)){
  if(input.catalog!==undefined&&!Array.isArray(input.catalog))throw new Error('模型列表格式无效');
  if((input.catalog||[]).length>200)throw new Error('模型列表最多 200 行');
  result.catalog=(input.catalog||[]).map(normalizeCatalogRow).filter(Boolean);
 }
 return result;
}
export function normalizeConnectionModelConfigs(modelConfigs,groups){
 if(modelConfigs===undefined||modelConfigs===null)return {};
 if(typeof modelConfigs!=='object'||Array.isArray(modelConfigs))throw new Error('模型配置格式无效');
 const allow=Array.isArray(groups)&&groups.length?new Set(groups):null;
 const out={};
 for(const [group,value] of Object.entries(modelConfigs)){
  if(!GROUP_IDS.includes(group))continue;
  if(allow&&!allow.has(group))continue;
  out[group]=normalizeModelConfig(group,value);
 }
 return out;
}
export function hasModelConfig(config){
 if(!config||typeof config!=='object')return false;
 if(config.defaultModel?.trim())return true;
 if(config.defaultEffort)return true;
 if(config.contextWindow)return true;
 if(config.catalog?.length)return true;
 if(config.env&&Object.values(config.env).some(v=>String(v||'').trim()))return true;
 return false;
}
export function defaultOutsideCatalog(config){return !!(config?.catalog?.length&&config.defaultModel?.trim()&&!config.catalog.some(r=>r.model.trim()===config.defaultModel.trim()));}
export function resolveRequestModel(config={}){
 if(!config||typeof config!=='object')return '';
 const catalog=Array.isArray(config.catalog)?config.catalog:[];
 const defaultModel=String(config.defaultModel||'').trim()||String(config.env?.ANTHROPIC_MODEL||'').trim()||String(catalog[0]?.model||'').trim();
 if(!defaultModel)return '';
 let effort='';
 try{effort=normalizeReasoningLevel(config.defaultEffort||'');}catch{effort='';}
 const row=catalog.find(item=>String(item?.model||'').trim()===defaultModel);
 const mapped=effort&&row?.effortModels&&typeof row.effortModels==='object'?String(row.effortModels[effort]||'').trim():'';
 return mapped||defaultModel;
}

export function modelConfigFor(connection={}, model=''){
 const configs=connection.modelConfigs&&typeof connection.modelConfigs==='object'&&!Array.isArray(connection.modelConfigs)?connection.modelConfigs:{};
 const id=String(model||'').trim();
 const matches=(config, mid)=>{
  if(!config||typeof config!=='object')return false;
  if(String(config.defaultModel||'').trim()===mid)return true;
  if(config.env&&Object.values(config.env).some(v=>String(v||'').trim()===mid))return true;
  for(const row of config.catalog||[]){
   if(String(row?.model||'').trim()===mid)return true;
   if(row?.effortModels&&Object.values(row.effortModels).some(v=>String(v||'').trim()===mid))return true;
  }
  return false;
 };
 if(id){
  for(const [group,config] of Object.entries(configs)){
   if(matches(config,id))return {group,config};
  }
 }
 const inferred=id?modelGroup(id):'';
 if(inferred&&configs[inferred])return {group:inferred,config:configs[inferred]};
 const official=String(connection.id||'');
 const officialGroup=official==='official-claude'?'claude':official==='official-codex'?'codex':official==='official-gemini'?'gemini':official==='official-grok'?'grok':'';
 if(officialGroup&&configs[officialGroup])return {group:officialGroup,config:configs[officialGroup]};
 if(inferred)return {group:inferred,config:configs[inferred]||{}};
 const first=Object.entries(configs)[0];
 return first?{group:first[0],config:first[1]}:{group:officialGroup,config:{}};
}

export function resolveChatModel(connection={}, selectedModel='', overrides={}){
 const selected=String(selectedModel||'').trim();
 const found=modelConfigFor(connection, selected);
 const config=found.config||{};
 const catalog=Array.isArray(config.catalog)?config.catalog:[];
 const fallback=String(config.defaultModel||'').trim()||String(config.env?.ANTHROPIC_MODEL||'').trim()||String(catalog[0]?.model||'').trim();
 const logical=selected||fallback;
 if(!logical)return {model:'',effort:'',group:found.group||''};
 const hasOverride=overrides&&Object.prototype.hasOwnProperty.call(overrides,'effort');
 let effort='';
 try{effort=normalizeReasoningLevel((hasOverride?overrides.effort:config.defaultEffort)||'');}catch{effort='';}
 const asEffortId=catalog.find(row=>row?.effortModels&&Object.values(row.effortModels).some(v=>String(v||'').trim()===logical));
 if(asEffortId){
  if(!effort&&!hasOverride){
   try{effort=normalizeReasoningLevel(asEffortId.defaultReasoningLevel||'');}catch{effort='';}
  }
  return {model:logical,effort,group:found.group||''};
 }
 const row=catalog.find(item=>String(item?.model||'').trim()===logical);
 if(!effort&&!hasOverride&&row?.defaultReasoningLevel){
  try{effort=normalizeReasoningLevel(row.defaultReasoningLevel);}catch{effort='';}
 }
 const mapped=effort&&row?.effortModels&&typeof row.effortModels==='object'?String(row.effortModels[effort]||'').trim():'';
 return {model:mapped||logical,effort,group:found.group||''};
}

export function connectionModelChoices(connection, group){
 if(!connection||typeof connection!=='object')return [];
 const seen=new Set();
 const out=[];
 const add=(id,label,g)=>{
  const model=String(id||'').trim();
  if(!model||seen.has(model))return;
  if(group&&g&&g!==group)return;
  seen.add(model);
  out.push({id:model,label:String(label||model).trim()||model,group:g||group||''});
 };
 const configs=connection.modelConfigs&&typeof connection.modelConfigs==='object'?connection.modelConfigs:{};
 const groups=group?[group]:Object.keys(configs);
 for(const g of groups){
  const config=configs[g];
  if(!config)continue;
  for(const row of config.catalog||[]) add(row.model, row.displayName||row.model, g);
  if(config.defaultModel) add(config.defaultModel, config.defaultModel, g);
  if(config.env){
   const parsed=parseClaudeModels(config.env);
   if(parsed.model) add(parsed.model, parsed.model, g);
   if(parsed.sonnet&&parsed.sonnet!==parsed.model) add(parsed.sonnet, `Sonnet · ${parsed.sonnet}`, g);
   if(parsed.opus&&parsed.opus!==parsed.model) add(parsed.opus, `Opus · ${parsed.opus}`, g);
   if(parsed.haiku) add(parsed.haiku, `Haiku · ${parsed.haiku}`, g);
   if(parsed.fable&&parsed.fable!==parsed.opus) add(parsed.fable, `Fable · ${parsed.fable}`, g);
   if(parsed.subagent) add(parsed.subagent, `Subagent · ${parsed.subagent}`, g);
  }
 }
 for(const item of connection.modelCatalog||connection.models||[]){
  const id=typeof item==='string'?item:item?.id;
  const inferred=modelGroup(id);
  if(group&&inferred&&inferred!==group)continue;
  add(id, typeof item==='object'&&item?.displayName?item.displayName:id, inferred||group||'');
 }
 return out;
}

export function preferredConnectionModel(connection, group){
 if(!connection)return '';
 const config=group?connection.modelConfigs?.[group]:null;
 if(config){
  const id=String(config.defaultModel||config.env?.ANTHROPIC_MODEL||'').trim();
  if(id)return id;
 }
 if(!group){
  for(const cfg of Object.values(connection.modelConfigs||{})){
   const id=String(cfg.defaultModel||cfg.env?.ANTHROPIC_MODEL||'').trim();
   if(id)return id;
  }
 }
 return connectionModelChoices(connection, group)[0]?.id||'';
}

export function managerSelectionView(connection={}, group='', manager=null){
 const current=manager&&connection&&manager.connectionId===connection.id?manager:null;
 const raw=String(current?.model||preferredConnectionModel(connection, group)||'').trim();
 const found=modelConfigFor(connection, raw);
 const config=(group&&connection.modelConfigs?.[group])||found.config||{};
 const catalog=Array.isArray(config.catalog)?config.catalog:[];
 const row=catalog.find(item=>String(item?.model||'').trim()===raw)
  ||catalog.find(item=>item?.effortModels&&Object.values(item.effortModels).some(v=>String(v||'').trim()===raw));
 const model=String(row?.model||raw||'').trim();
 const levels=Array.isArray(row?.reasoningLevels)&&row.reasoningLevels.length
  ?REASONING_LEVELS.filter(level=>row.reasoningLevels.includes(level))
  :REASONING_LEVELS.slice();
 const matchedEffort=row?.effortModels&&typeof row.effortModels==='object'
  ?Object.entries(row.effortModels).find(([,id])=>String(id||'').trim()===raw)?.[0]
  :'';
 let effortSource;
 if(current&&Object.prototype.hasOwnProperty.call(current,'effort')) effortSource=current.effort;
 else effortSource=matchedEffort||row?.defaultReasoningLevel||config.defaultEffort||'';
 let effort='';
 try{effort=normalizeReasoningLevel(effortSource||'');}catch{effort='';}
 if(effort&&levels.length&&!levels.includes(effort)) effort='';
 let contextWindow='';
 if(current&&Object.prototype.hasOwnProperty.call(current,'contextWindow')&&current.contextWindow!==''&&current.contextWindow!=null){
  contextWindow=current.contextWindow;
 }else{
  contextWindow=row?.contextWindow??config.contextWindow??'';
 }
 return {model,effort,contextWindow,levels};
}

export function managerModelDefaults(connection, group, model){
 const id=String(model||preferredConnectionModel(connection, group)||'').trim();
 if(!connection) return {model:id,effort:'',contextWindow:'',levels:REASONING_LEVELS.slice()};
 return managerSelectionView(connection, group, {connectionId:connection.id,model:id});
}
