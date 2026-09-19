import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'src-tauri','resources');
for(const dir of ['src','public','node'])fs.mkdirSync(path.join(out,dir),{recursive:true});
for(const name of ['server.mjs','auth.mjs','core.mjs','secret-store.mjs','oauth-manager.mjs','cpa-oauth.mjs','official-client-http.mjs','model-fetch.mjs','antigravity-credential.mjs','session-timezone.mjs'])fs.copyFileSync(path.join(root,'src',name),path.join(out,'src',name));
for(const name of ['index.html','app.js','style.css','shell.js','model-groups.js','model-selection.js','model-config-ui.js','provider-presets.js','provider-card.js','provider-modal.js','protocols.js'])fs.copyFileSync(path.join(root,'public',name),path.join(out,'public',name));
const iconsSrc=path.join(root,'public','icons');
const iconsDst=path.join(out,'public','icons');
if(fs.existsSync(iconsSrc)){
  fs.mkdirSync(iconsDst,{recursive:true});
  for(const name of fs.readdirSync(iconsSrc))fs.copyFileSync(path.join(iconsSrc,name),path.join(iconsDst,name));
}
fs.copyFileSync(process.execPath,path.join(out,'node','node.exe'));
console.log('桌面资源已准备；不包含用户数据或凭据。');



