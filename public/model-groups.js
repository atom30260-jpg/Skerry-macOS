export const MODEL_GROUPS = [
 {id:'claude',name:'Claude',officialIds:['official-claude']},
 {id:'codex',name:'Codex',officialIds:['official-codex']},
 {id:'gemini',name:'Gemini',officialIds:['official-gemini']},
 {id:'grok',name:'Grok',officialIds:['official-grok']},
];
export function modelGroup(model){
 const id=String(model||'').toLowerCase().split('/').at(-1);
 if(/^claude(?:-|$)/.test(id))return 'claude';
 if(/^(?:gpt-|chatgpt-|codex(?:-|$)|o[134](?:-|$))/.test(id))return 'codex';
 if(/^gemini(?:-|$)/.test(id))return 'gemini';
 if(/^grok(?:-|$)/.test(id))return 'grok';
 return null;
}
export function validateModelGroups(groups){
 if(!Array.isArray(groups)||!groups.length||groups.some(id=>!MODEL_GROUPS.some(g=>g.id===id)))throw new Error('请至少选择一个有效的模型分组');
 return [...new Set(groups)];
}
export function connectionGroups(connection){
 if(Array.isArray(connection.modelGroups)&&connection.modelGroups.length)return [...new Set(connection.modelGroups.filter(id=>MODEL_GROUPS.some(g=>g.id===id)))];
 const official=MODEL_GROUPS.find(g=>g.officialIds.includes(connection.id));
 if(official)return [official.id];
 const models=(connection.models||[]).map(m=>typeof m==='string'?m:m.id).filter(Boolean);
 return [...new Set(models.map(modelGroup).filter(Boolean))];
}
export function connectionsInGroup(connections,groupId){return connections.filter(c=>connectionGroups(c).includes(groupId));}
