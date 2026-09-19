import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {cpaOAuthSpec,createCpaOAuthHost} from './cpa-oauth.mjs';
import {OAuthError,OAuthManager} from './oauth-manager.mjs';
import {official,statuses} from './auth.mjs';

function fakeJwt(payload){
 return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function grokFetch({pending=0, onToken, refresh}={}){
 let polls=0;
 return async(url,init)=>{
  const href=String(url);
  if(href.includes('openid-configuration')){
   return {ok:true,json:async()=>({
    device_authorization_endpoint:'https://auth.x.ai/oauth2/device/code',
    token_endpoint:'https://auth.x.ai/oauth2/token',
   })};
  }
  if(href.includes('/device/code')){
   const body=Object.fromEntries(new URLSearchParams(init.body));
   assert.equal(body.client_id,'b1a00492-073a-47ea-816f-4c329264a828');
   assert.match(body.scope,/openid/);
   assert.match(body.scope,/offline_access/);
   assert.match(body.scope,/grok-cli:access/);
   return {ok:true,json:async()=>({
    device_code:'device-1',
    user_code:'ABCD-1234',
    verification_uri:'https://auth.x.ai/device',
    verification_uri_complete:'https://auth.x.ai/device?user_code=ABCD-1234',
    interval:5,
    expires_in:900,
   })};
  }
  if(href.includes('/oauth2/token')){
   const body=Object.fromEntries(new URLSearchParams(init.body));
   onToken?.(body);
   if(body.grant_type==='refresh_token'){
    if(refresh==='invalid_grant'){
     return {ok:false,status:400,json:async()=>({error:'invalid_grant',error_description:'secret-xai-revoke'})};
    }
    if(refresh==='empty_rt'){
     return {ok:true,json:async()=>({access_token:'grok-at-new',refresh_token:'',token_type:'Bearer',expires_in:3600})};
    }
    if(refresh==='network')throw new Error('network down');
    return {ok:true,json:async()=>({access_token:'grok-at-new',token_type:'Bearer',expires_in:3600})};
   }
   polls+=1;
   if(polls<=pending){
    return {ok:false,status:400,json:async()=>({error:'authorization_pending'})};
   }
   return {ok:true,json:async()=>({
    access_token:'grok-at',
    refresh_token:'grok-rt',
    id_token:fakeJwt({email:'grok@example.com'}),
    token_type:'Bearer',
    expires_in:3600,
   })};
  }
  throw new Error('unexpected '+href);
 };
}

test('Grok 官方登录走 xAI device code，不依赖本机 CLI',()=>{
 const spec=cpaOAuthSpec('official-grok',{});
 assert.equal(spec.flow,'device');
 assert.equal(spec.discoveryEndpoint,'https://auth.x.ai/.well-known/openid-configuration');
 assert.equal(spec.clientId,'b1a00492-073a-47ea-816f-4c329264a828');
 assert.equal(spec.callbackPort,0);
 assert.ok(!spec.redirectUri);
 const grok=official.find(item=>item.id==='official-grok');
 assert.equal(grok.authLabel,'xAI 账号');
 assert.equal(grok.description,'浏览器完成 xAI 授权后，工作台保存凭证。');
 assert.doesNotMatch(grok.description,/CLI|无需安装/);
 const authSource=fs.readFileSync(new URL('./auth.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(authSource,/spawn\('grok'|login',\s*'--oauth'|cliAuthFiles|\.grok['"]/);
 const appSource=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.doesNotMatch(appSource,/official-grok'\?null/);
 assert.match(appSource,/完成 xAI 账号授权/);
 assert.doesNotMatch(appSource,/不启动 Grok CLI|无需安装 Grok CLI/);
});

test('Grok device 登录把 AT/RT 交给工作台，等待授权时不落盘',async()=>{
 const host=createCpaOAuthHost('official-grok',{},{fetchImpl:grokFetch({pending:1})});
 const saved=[];
 let now=1_700_000_000_000;
 const manager=new OAuthManager({hosts:{'official-grok':host},saveToken:(_id,token)=>saved.push(token),now:()=>now});
 const start=await manager.start('official-grok');
 assert.equal(start.flow,'device');
 assert.equal(start.userCode,'ABCD-1234');
 assert.equal(start.verificationUriComplete,'https://auth.x.ai/device?user_code=ABCD-1234');
 const pending=await manager.poll('official-grok',start.transactionId);
 assert.equal(pending.status,'pending');
 assert.equal(saved.length,0);
 now+=6_000;
 const done=await manager.poll('official-grok',start.transactionId);
 assert.equal(done.status,'connected');
 assert.equal(JSON.stringify(done).includes('grok-at'),false);
 assert.equal(saved[0].accessToken,'grok-at');
 assert.equal(saved[0].refreshToken,'grok-rt');
 assert.equal(saved[0].email,'grok@example.com');
});

test('Grok 刷新按 xAI token 端点换 AT，Google 式窗口外不刷新，无新 RT 时保留旧 RT',async()=>{
 const calls=[];
 const host=createCpaOAuthHost('official-grok',{},{fetchImpl:grokFetch({onToken:body=>calls.push(body)})});
 const now=1_700_000_000_000;
 let saved;
 const manager=new OAuthManager({
  hosts:{'official-grok':host},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'grok-at-old',refreshToken:'grok-rt',expiresAt:now+60_000,email:'grok@example.com'}),
  saveToken:(_id,token)=>{saved=token;},
 });
 assert.equal(await manager.accessTokenForRuntime('official-grok'),'grok-at-new');
 assert.equal(calls.at(-1).grant_type,'refresh_token');
 assert.equal(calls.at(-1).refresh_token,'grok-rt');
 assert.equal(calls.at(-1).client_id,'b1a00492-073a-47ea-816f-4c329264a828');
 assert.equal(saved.refreshToken,'grok-rt');
 const far=new OAuthManager({
  hosts:{'official-grok':createCpaOAuthHost('official-grok',{},{fetchImpl:grokFetch({onToken:()=>{throw new Error('must not refresh');}})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'grok-still-valid',refreshToken:'grok-rt',expiresAt:now+6*60*1000}),
 });
 assert.equal(await far.accessTokenForRuntime('official-grok'),'grok-still-valid');
});

test('Grok 刷新返回空 RT 时保留旧 RT',async()=>{
 let saved;
 const now=1_700_000_000_000;
 const manager=new OAuthManager({
  hosts:{'official-grok':createCpaOAuthHost('official-grok',{},{fetchImpl:grokFetch({refresh:'empty_rt'})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'grok-at-old',refreshToken:'grok-rt',expiresAt:now+60_000,email:'grok@example.com'}),
  saveToken:(_id,token)=>{saved=token;},
 });
 assert.equal(await manager.accessTokenForRuntime('official-grok'),'grok-at-new');
 assert.equal(saved.refreshToken,'grok-rt');
 assert.equal(saved.email,'grok@example.com');
});

test('Grok 刷新 invalid_grant 时公开状态改为需重新登录，网络失败则不改展示',async()=>{
 const now=1_700_000_000_000;
 let saved={accessToken:'grok-at-old',refreshToken:'grok-rt',expiresAt:now+60_000,email:'grok@example.com'};
 const manager=new OAuthManager({
  hosts:{'official-grok':createCpaOAuthHost('official-grok',{},{fetchImpl:grokFetch({refresh:'invalid_grant'})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>saved,
  saveToken:(_id,token)=>{saved=token;},
  deleteToken:()=>{saved=null;},
 });
 await assert.rejects(
  ()=>manager.accessTokenForRuntime('official-grok'),
  err=>err instanceof OAuthError && err.code==='invalid_grant',
 );
 const status=manager.status('official-grok');
 assert.equal(status.connected,true);
 assert.equal(status.expired,true);
 assert.equal(status.authError.code,'invalid_grant');
 assert.equal(status.authError.message,'授权已失效，请重新登录。');
 assert.equal(JSON.stringify(status).includes('secret-xai-revoke'),false);
 assert.equal(saved.refreshToken,'grok-rt');
 manager.disconnect('official-grok');
 assert.equal(manager.status('official-grok').connected,false);
 assert.equal(manager.status('official-grok').authError,undefined);

 const net=new OAuthManager({
  hosts:{'official-grok':createCpaOAuthHost('official-grok',{},{fetchImpl:grokFetch({refresh:'network'})})},
  refreshLeewayMs:5*60*1000,
  now:()=>now,
  loadToken:()=>({accessToken:'grok-at-old',refreshToken:'grok-rt',expiresAt:now+60_000}),
  saveToken:()=>{throw new Error('must not persist on network failure');},
 });
 await assert.rejects(()=>net.accessTokenForRuntime('official-grok'));
 assert.equal(net.status('official-grok').connected,true);
 assert.equal(net.status('official-grok').expired,false);
 assert.equal(net.status('official-grok').authError,undefined);
});

test('Grok 状态只来自工作台凭证，未登录时也是 device 流',()=>{
 const grok=statuses().find(item=>item.id==='official-grok');
 assert.equal(grok.flow,'device');
 assert.equal(grok.loginAvailable,true);
 assert.notEqual(grok.flow,'cli');
 assert.ok(!grok.credentialSource || grok.credentialSource==='工作台 xAI 授权');
 assert.equal(JSON.stringify(grok).includes('accessToken'),false);
 assert.equal(JSON.stringify(grok).includes('refreshToken'),false);
});

test('Grok discovery 拒绝非 x.ai 端点',async()=>{
 const host=createCpaOAuthHost('official-grok',{},{
  fetchImpl:async()=>({ok:true,json:async()=>({
   device_authorization_endpoint:'https://evil.example/device',
   token_endpoint:'https://evil.example/token',
  })}),
 });
 await assert.rejects(()=>host.startDeviceAuthorization(),/invalid endpoint/i);
});
