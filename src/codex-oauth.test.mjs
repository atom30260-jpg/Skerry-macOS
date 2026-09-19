import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cpaOAuthSpec,createCpaOAuthHost} from './cpa-oauth.mjs';
import {OAuthError,OAuthManager} from './oauth-manager.mjs';
import {official,statuses} from './auth.mjs';
import {CODEX_CLI_ORIGINATOR,CODEX_CLI_USER_AGENT} from './official-client-http.mjs';

function fakeJwt(payload){
 return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function header(init,name){
 const h=init.headers||{};
 const key=Object.keys(h).find(k=>k.toLowerCase()===name.toLowerCase());
 return key==null?undefined:h[key];
}

function codexFetch({onBody, refresh}={}){
 return async(url,init)=>{
  const href=String(url);
  assert.equal(href,'https://auth.openai.com/oauth/token');
  assert.match(String(header(init,'content-type')),/x-www-form-urlencoded/);
  assert.equal(header(init,'user-agent'),CODEX_CLI_USER_AGENT);
  assert.equal(header(init,'originator'),CODEX_CLI_ORIGINATOR);
  const body=Object.fromEntries(new URLSearchParams(init.body));
  onBody?.(body);
  if(body.grant_type==='refresh_token'){
   if(refresh==='invalid_grant'){
    return {ok:false,status:400,json:async()=>({error:'invalid_grant',error_description:'secret-codex-revoke'})};
   }
   if(refresh==='empty_rt'){
    return {ok:true,json:async()=>({access_token:'codex-at-new',refresh_token:'',token_type:'Bearer',expires_in:3600})};
   }
   if(refresh==='network')throw new Error('network down');
   return {ok:true,json:async()=>({
    access_token:'codex-at-new',
    token_type:'Bearer',
    expires_in:3600,
    id_token:fakeJwt({email:'codex@example.com','https://api.openai.com/auth':{chatgpt_account_id:'acct_codex'}}),
   })};
  }
  return {ok:true,json:async()=>({
   access_token:'codex-at',
   refresh_token:'codex-rt',
   token_type:'Bearer',
   expires_in:3600,
   id_token:fakeJwt({email:'codex@example.com','https://api.openai.com/auth':{chatgpt_account_id:'acct_codex'}}),
  })};
 };
}

test('Codex 官方登录走 OpenAI PKCE 本机回调，换票伪造 Codex CLI 身份，不启动 Codex CLI',()=>{
 const spec=cpaOAuthSpec('official-codex',{});
 assert.equal(spec.flow,'browser');
 assert.equal(spec.authorizationEndpoint,'https://auth.openai.com/oauth/authorize');
 assert.equal(spec.tokenEndpoint,'https://auth.openai.com/oauth/token');
 assert.equal(spec.clientId,'app_EMoamEEZ73f0CkXaXp7hrann');
 assert.equal(spec.redirectUri,'http://localhost:1455/auth/callback');
 assert.equal(spec.callbackPort,1455);
 assert.equal(spec.includeStateInTokenRequest,false);
 assert.equal(spec.extraRequestHeaders['User-Agent'],CODEX_CLI_USER_AGENT);
 assert.equal(spec.extraRequestHeaders.Originator,CODEX_CLI_ORIGINATOR);
 const codex=official.find(item=>item.id==='official-codex');
 assert.equal(codex.authLabel,'OpenAI 账号');
 assert.equal(codex.description,'浏览器完成 OpenAI 授权后，工作台保存凭证。');
 assert.doesNotMatch(codex.description,/CLI|无需安装/);
 const authSource=fs.readFileSync(new URL('./auth.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(authSource,/spawn\('codex'|codex\.exe|openCodexCli/);
 const appSource=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(appSource,/完成 OpenAI 账号授权/);
 assert.doesNotMatch(appSource,/不启动 Codex CLI|无需安装 Codex CLI/);
});

test('Codex 授权 URL 使用官方 localhost 回调和 PKCE',async()=>{
 const spec=cpaOAuthSpec('official-codex',{});
 const host=createCpaOAuthHost('official-codex',{});
 const url=await host.createAuthorizationUrl({
  state:'state-value',
  codeVerifier:'verifier-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  redirectUri:spec.redirectUri,
 });
 const parsed=new URL(url);
 assert.equal(parsed.origin+parsed.pathname,'https://auth.openai.com/oauth/authorize');
 assert.equal(parsed.searchParams.get('client_id'),spec.clientId);
 assert.equal(parsed.searchParams.get('redirect_uri'),'http://localhost:1455/auth/callback');
 assert.equal(parsed.searchParams.get('prompt'),null);
 assert.equal(parsed.searchParams.get('id_token_add_organizations'),'true');
 assert.equal(parsed.searchParams.get('codex_cli_simplified_flow'),'true');
 assert.equal(parsed.searchParams.get('originator'),CODEX_CLI_ORIGINATOR);
 assert.equal(parsed.searchParams.get('code_challenge_method'),'S256');
 assert.equal(parsed.searchParams.get('scope'),'openid profile email offline_access api.connectors.read api.connectors.invoke');
 await assert.rejects(
  ()=>host.createAuthorizationUrl({state:'x',codeVerifier:'y',redirectUri:'https://evil.example/callback'}),
  /redirectUri is not allowed/,
 );
});

test('Codex 换票使用表单且不发送 state，并从 id_token 解析邮箱和 ChatGPT 账号',async()=>{
 let tokenBody;
 const host=createCpaOAuthHost('official-codex',{},{fetchImpl:codexFetch({onBody:body=>{tokenBody=body;}})});
 const token=await host.exchangeCode({
  code:'auth-code',
  codeVerifier:'pkce-verifier',
  redirectUri:'http://localhost:1455/auth/callback',
  state:'browser-state',
 });
 assert.equal(tokenBody.grant_type,'authorization_code');
 assert.equal(tokenBody.code,'auth-code');
 assert.equal(tokenBody.code_verifier,'pkce-verifier');
 assert.equal(tokenBody.redirect_uri,'http://localhost:1455/auth/callback');
 assert.equal(tokenBody.client_id,'app_EMoamEEZ73f0CkXaXp7hrann');
 assert.equal(tokenBody.state,undefined);
 assert.equal(token.access_token,'codex-at');
 assert.equal(token.refresh_token,'codex-rt');
 assert.equal(token.email,'codex@example.com');
 assert.equal(token.accountID,'acct_codex');
});

test('Codex 登录把 AT/RT 交给工作台，公开状态不含令牌',async()=>{
 const host=createCpaOAuthHost('official-codex',{},{fetchImpl:codexFetch()});
 const saved=[];
 const manager=new OAuthManager({hosts:{'official-codex':host},saveToken:(_id,token)=>saved.push(token)});
 const start=await manager.start('official-codex',{redirectUri:'http://localhost:1455/auth/callback'});
 assert.equal(start.flow,'browser');
 assert.match(start.authorizationUrl,/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
 assert.equal(JSON.stringify(start).includes('codex-at'),false);
 const done=await manager.callback('official-codex',{code:'auth-code',state:start.state});
 assert.equal(done.status,'connected');
 assert.equal(JSON.stringify(done).includes('codex-at'),false);
 assert.equal(saved[0].accessToken,'codex-at');
 assert.equal(saved[0].refreshToken,'codex-rt');
 assert.equal(saved[0].email,'codex@example.com');
 assert.equal(saved[0].accountID,'acct_codex');
});

test('Codex 刷新按 OpenAI token 端点换 AT，带 Codex 刷新 scope，无新 RT 时保留旧 RT',async()=>{
 const calls=[];
 const now=1_700_000_000_000;
 let saved;
 const manager=new OAuthManager({
  hosts:{'official-codex':createCpaOAuthHost('official-codex',{},{fetchImpl:codexFetch({onBody:body=>calls.push(body)})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'codex-at-old',refreshToken:'codex-rt',expiresAt:now+60_000,email:'codex@example.com',accountID:'acct_codex'}),
  saveToken:(_id,token)=>{saved=token;},
 });
 assert.equal(await manager.accessTokenForRuntime('official-codex'),'codex-at-new');
 assert.equal(calls.at(-1).grant_type,'refresh_token');
 assert.equal(calls.at(-1).refresh_token,'codex-rt');
 assert.equal(calls.at(-1).client_id,'app_EMoamEEZ73f0CkXaXp7hrann');
 assert.equal(calls.at(-1).scope,'openid profile email');
 assert.equal(saved.refreshToken,'codex-rt');
 assert.equal(saved.email,'codex@example.com');
 assert.equal(saved.accountID,'acct_codex');
 const far=new OAuthManager({
  hosts:{'official-codex':createCpaOAuthHost('official-codex',{},{fetchImpl:codexFetch({onBody:()=>{throw new Error('must not refresh');}})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'codex-still-valid',refreshToken:'codex-rt',expiresAt:now+6*60*1000}),
 });
 assert.equal(await far.accessTokenForRuntime('official-codex'),'codex-still-valid');
});

test('Codex 刷新返回空 RT 时保留旧 RT',async()=>{
 let saved;
 const now=1_700_000_000_000;
 const manager=new OAuthManager({
  hosts:{'official-codex':createCpaOAuthHost('official-codex',{},{fetchImpl:codexFetch({refresh:'empty_rt'})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'codex-at-old',refreshToken:'codex-rt',expiresAt:now+60_000,email:'codex@example.com'}),
  saveToken:(_id,token)=>{saved=token;},
 });
 assert.equal(await manager.accessTokenForRuntime('official-codex'),'codex-at-new');
 assert.equal(saved.refreshToken,'codex-rt');
});

test('Codex 刷新 invalid_grant 时公开状态改为需重新登录，网络失败则不改展示',async()=>{
 const now=1_700_000_000_000;
 let saved={accessToken:'codex-at-old',refreshToken:'codex-rt',expiresAt:now+60_000,email:'codex@example.com'};
 const manager=new OAuthManager({
  hosts:{'official-codex':createCpaOAuthHost('official-codex',{},{fetchImpl:codexFetch({refresh:'invalid_grant'})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>saved,
  saveToken:(_id,token)=>{saved=token;},
  deleteToken:()=>{saved=null;},
 });
 await assert.rejects(
  ()=>manager.accessTokenForRuntime('official-codex'),
  err=>err instanceof OAuthError && err.code==='invalid_grant',
 );
 const status=manager.status('official-codex');
 assert.equal(status.connected,true);
 assert.equal(status.expired,true);
 assert.equal(status.authError.code,'invalid_grant');
 assert.equal(status.authError.message,'授权已失效，请重新登录。');
 assert.equal(JSON.stringify(status).includes('secret-codex-revoke'),false);
 assert.equal(saved.refreshToken,'codex-rt');
 const net=new OAuthManager({
  hosts:{'official-codex':createCpaOAuthHost('official-codex',{},{fetchImpl:codexFetch({refresh:'network'})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'codex-at-old',refreshToken:'codex-rt',expiresAt:now+60_000}),
  saveToken:()=>{throw new Error('must not persist on network failure');},
 });
 await assert.rejects(()=>net.accessTokenForRuntime('official-codex'));
 assert.equal(net.status('official-codex').connected,true);
 assert.equal(net.status('official-codex').expired,false);
 assert.equal(net.status('official-codex').authError,undefined);
});

test('Codex 状态只来自工作台凭证',()=>{
 const codex=statuses().find(item=>item.id==='official-codex');
 assert.equal(codex.flow,'browser');
 assert.equal(codex.loginAvailable,true);
 assert.ok(!codex.credentialSource || codex.credentialSource==='工作台 OpenAI 授权');
 assert.equal(JSON.stringify(codex).includes('accessToken'),false);
 assert.equal(JSON.stringify(codex).includes('refreshToken'),false);
});
