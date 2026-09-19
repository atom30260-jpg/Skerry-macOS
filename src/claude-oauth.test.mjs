import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cpaOAuthSpec,createCpaOAuthHost} from './cpa-oauth.mjs';
import {OAuthError,OAuthManager} from './oauth-manager.mjs';
import {official,statuses} from './auth.mjs';

import {CLAUDE_OAUTH_USER_AGENT,CLAUDE_OAUTH_ACCEPT} from './official-client-http.mjs';

const CLAUDE_SCOPE='user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

function header(init,name){
 const h=init.headers||{};
 const key=Object.keys(h).find(k=>k.toLowerCase()===name.toLowerCase());
 return key==null?undefined:h[key];
}

function claudeFetch({onBody, refresh}={}){
 return async(url,init)=>{
  const href=String(url);
  assert.equal(href,'https://platform.claude.com/v1/oauth/token');
  assert.match(String(header(init,'content-type')),/json/);
  assert.equal(header(init,'user-agent'),CLAUDE_OAUTH_USER_AGENT);
  assert.equal(header(init,'accept'),CLAUDE_OAUTH_ACCEPT);
  assert.equal(header(init,'connection'),'close');
  assert.doesNotMatch(String(header(init,'user-agent')),/claude-cli/i);
  const body=JSON.parse(init.body);
  onBody?.(body,init.body);
  if(body.grant_type==='refresh_token'){
   if(refresh==='invalid_grant'){
    return {ok:false,status:400,json:async()=>({error:'invalid_grant',error_description:'secret-claude-revoke'})};
   }
   if(refresh==='empty_rt'){
    return {ok:true,json:async()=>({access_token:'claude-at-new',refresh_token:'',token_type:'Bearer',expires_in:3600})};
   }
   if(refresh==='network')throw new Error('network down');
   return {ok:true,json:async()=>({access_token:'claude-at-new',token_type:'Bearer',expires_in:3600})};
  }
  return {ok:true,json:async()=>({
   access_token:'claude-at',
   refresh_token:'claude-rt',
   token_type:'Bearer',
   expires_in:28800,
   account:{uuid:'acct-uuid',email_address:'claude@example.com'},
   organization:{uuid:'org-uuid',name:'Example Org'},
  })};
 };
}

test('Claude 官方登录走 Anthropic PKCE 本机回调，换票伪造 Claude Code Axios，不启动 Claude CLI',()=>{
 const spec=cpaOAuthSpec('official-claude',{});
 assert.equal(spec.flow,'browser');
 assert.equal(spec.authorizationEndpoint,'https://claude.ai/oauth/authorize');
 assert.equal(spec.tokenEndpoint,'https://platform.claude.com/v1/oauth/token');
 assert.equal(spec.clientId,'9d1c250a-e61b-44d9-88ed-5944d1962f5e');
 assert.equal(spec.redirectUri,'http://localhost:54545/callback');
 assert.equal(spec.callbackPort,54545);
 assert.equal(spec.tokenContentType,'json');
 assert.equal(spec.extraAuthorizationParams.code,'true');
 assert.equal(spec.extraRequestHeaders['User-Agent'],CLAUDE_OAUTH_USER_AGENT);
 const claude=official.find(item=>item.id==='official-claude');
 assert.equal(claude.authLabel,'Anthropic 账号');
 assert.equal(claude.description,'浏览器完成 Anthropic 授权后，工作台保存凭证。');
 assert.doesNotMatch(claude.description,/CLI|无需安装/);
 const authSource=fs.readFileSync(new URL('./auth.mjs',import.meta.url),'utf8');
 const cpaSource=fs.readFileSync(new URL('./cpa-oauth.mjs',import.meta.url),'utf8');
 const httpSource=fs.readFileSync(new URL('./official-client-http.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(authSource,/spawn\('claude'|claude\.exe|openClaudeCli/);
 assert.match(httpSource,/axios\/1\.15\.2/);
 assert.match(cpaSource,/extraClaudeOAuthHeaders|claudeOAuthFetch/);
 const appSource=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(appSource,/完成 Anthropic 账号授权/);
 assert.doesNotMatch(appSource,/不启动 Claude CLI|无需安装 Claude CLI/);
});

test('Claude 授权 URL 使用官方 localhost 回调和 PKCE',async()=>{
 const spec=cpaOAuthSpec('official-claude',{});
 const host=createCpaOAuthHost('official-claude',{});
 const url=await host.createAuthorizationUrl({
  state:'state-value',
  codeVerifier:'verifier-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  redirectUri:spec.redirectUri,
 });
 const parsed=new URL(url);
 assert.equal(parsed.origin+parsed.pathname,'https://claude.ai/oauth/authorize');
 assert.equal(parsed.searchParams.get('client_id'),spec.clientId);
 assert.equal(parsed.searchParams.get('redirect_uri'),'http://localhost:54545/callback');
 assert.equal(parsed.searchParams.get('code'),'true');
 assert.equal(parsed.searchParams.get('code_challenge_method'),'S256');
 assert.equal(parsed.searchParams.get('scope'),CLAUDE_SCOPE);
 await assert.rejects(
  ()=>host.createAuthorizationUrl({state:'x',codeVerifier:'y',redirectUri:'https://evil.example/callback'}),
  /redirectUri is not allowed/,
 );
});

test('Claude 换票使用 JSON 字段顺序，并从 account.email_address 解析邮箱，回调 code#state 可拆开',async()=>{
 let rawBody;
 const host=createCpaOAuthHost('official-claude',{},{fetchImpl:claudeFetch({onBody:(_body,raw)=>{rawBody=raw;}})});
 const token=await host.exchangeCode({
  code:'auth-code#state-from-fragment',
  codeVerifier:'verifier',
  redirectUri:'http://localhost:54545/callback',
  state:'ignored-when-fragment',
 });
 assert.equal(rawBody,'{"grant_type":"authorization_code","code":"auth-code","redirect_uri":"http://localhost:54545/callback","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","code_verifier":"verifier","state":"state-from-fragment"}');
 assert.equal(token.access_token,'claude-at');
 assert.equal(token.refresh_token,'claude-rt');
 assert.equal(token.email,'claude@example.com');
 assert.equal(token.accountUUID,'acct-uuid');
 assert.equal(token.organizationUUID,'org-uuid');
 assert.equal(token.organizationName,'Example Org');
});

test('Claude 登录把 AT/RT 交给工作台，公开状态不含令牌',async()=>{
 const host=createCpaOAuthHost('official-claude',{},{fetchImpl:claudeFetch()});
 const saved=[];
 const manager=new OAuthManager({hosts:{'official-claude':host},saveToken:(_id,token)=>saved.push(token)});
 const start=await manager.start('official-claude',{redirectUri:'http://localhost:54545/callback'});
 assert.equal(start.flow,'browser');
 assert.match(start.authorizationUrl,/^https:\/\/claude\.ai\/oauth\/authorize\?/);
 assert.equal(JSON.stringify(start).includes('claude-at'),false);
 const done=await manager.callback('official-claude',{code:'auth-code',state:start.state});
 assert.equal(done.status,'connected');
 assert.equal(JSON.stringify(done).includes('claude-at'),false);
 assert.equal(saved[0].accessToken,'claude-at');
 assert.equal(saved[0].refreshToken,'claude-rt');
 assert.equal(saved[0].email,'claude@example.com');
});

test('Claude 刷新按 Anthropic JSON 换 AT，无新 RT 时保留旧 RT，窗口外不刷新',async()=>{
 let rawBody;
 const now=1_700_000_000_000;
 const manager=new OAuthManager({
  hosts:{'official-claude':createCpaOAuthHost('official-claude',{},{fetchImpl:claudeFetch({onBody:(_b,raw)=>{rawBody=raw;}})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'claude-at-old',refreshToken:'claude-rt',expiresAt:now+60_000,email:'claude@example.com',accountUUID:'acct-uuid'}),
  saveToken:(_id,token)=>{manager.saved=token;},
 });
 assert.equal(await manager.accessTokenForRuntime('official-claude'),'claude-at-new');
 assert.equal(rawBody,'{"client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","grant_type":"refresh_token","refresh_token":"claude-rt","scope":"'+CLAUDE_SCOPE+'"}');
 assert.equal(manager.saved.refreshToken,'claude-rt');
 assert.equal(manager.saved.email,'claude@example.com');
 const far=new OAuthManager({
  hosts:{'official-claude':createCpaOAuthHost('official-claude',{},{fetchImpl:claudeFetch({onBody:()=>{throw new Error('must not refresh');}})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'claude-still-valid',refreshToken:'claude-rt',expiresAt:now+6*60*1000}),
 });
 assert.equal(await far.accessTokenForRuntime('official-claude'),'claude-still-valid');
});

test('Claude 刷新返回空 RT 时保留旧 RT',async()=>{
 let saved;
 const now=1_700_000_000_000;
 const manager=new OAuthManager({
  hosts:{'official-claude':createCpaOAuthHost('official-claude',{},{fetchImpl:claudeFetch({refresh:'empty_rt'})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'claude-at-old',refreshToken:'claude-rt',expiresAt:now+60_000,email:'claude@example.com'}),
  saveToken:(_id,token)=>{saved=token;},
 });
 assert.equal(await manager.accessTokenForRuntime('official-claude'),'claude-at-new');
 assert.equal(saved.refreshToken,'claude-rt');
});

test('Claude 刷新 invalid_grant 时公开状态改为需重新登录，网络失败则不改展示',async()=>{
 const now=1_700_000_000_000;
 let saved={accessToken:'claude-at-old',refreshToken:'claude-rt',expiresAt:now+60_000,email:'claude@example.com'};
 const manager=new OAuthManager({
  hosts:{'official-claude':createCpaOAuthHost('official-claude',{},{fetchImpl:claudeFetch({refresh:'invalid_grant'})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>saved,
  saveToken:(_id,token)=>{saved=token;},
  deleteToken:()=>{saved=null;},
 });
 await assert.rejects(
  ()=>manager.accessTokenForRuntime('official-claude'),
  err=>err instanceof OAuthError && err.code==='invalid_grant',
 );
 const status=manager.status('official-claude');
 assert.equal(status.connected,true);
 assert.equal(status.expired,true);
 assert.equal(status.authError.code,'invalid_grant');
 assert.equal(status.authError.message,'授权已失效，请重新登录。');
 assert.equal(JSON.stringify(status).includes('secret-claude-revoke'),false);
 assert.equal(saved.refreshToken,'claude-rt');
 const net=new OAuthManager({
  hosts:{'official-claude':createCpaOAuthHost('official-claude',{},{fetchImpl:claudeFetch({refresh:'network'})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'claude-at-old',refreshToken:'claude-rt',expiresAt:now+60_000}),
  saveToken:()=>{throw new Error('must not persist on network failure');},
 });
 await assert.rejects(()=>net.accessTokenForRuntime('official-claude'));
 assert.equal(net.status('official-claude').connected,true);
 assert.equal(net.status('official-claude').expired,false);
 assert.equal(net.status('official-claude').authError,undefined);
});

test('Claude 状态只来自工作台凭证',()=>{
 const claude=statuses().find(item=>item.id==='official-claude');
 assert.equal(claude.flow,'browser');
 assert.equal(claude.loginAvailable,true);
 assert.ok(!claude.credentialSource || claude.credentialSource==='工作台 Anthropic 授权');
 assert.equal(JSON.stringify(claude).includes('accessToken'),false);
 assert.equal(JSON.stringify(claude).includes('refreshToken'),false);
});
