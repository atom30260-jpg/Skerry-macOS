import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import tls from 'node:tls';
import {
  CLAUDE_OAUTH_ACCEPT,
  CLAUDE_OAUTH_ACCEPT_ENCODING,
  CLAUDE_OAUTH_CIPHERS,
  CLAUDE_OAUTH_HEADER_ORDER,
  CLAUDE_OAUTH_USER_AGENT,
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
  CODEX_OAUTH_HEADER_ORDER,
  claudeOAuthFetch,
  claudeOAuthTlsConnectOptions,
  codexOAuthFetch,
  defaultFetchFor,
  extraClaudeOAuthHeaders,
  extraCodexOAuthHeaders,
  orderHttp1RequestHeaders,
} from './official-client-http.mjs';
import {cpaOAuthSpec} from './cpa-oauth.mjs';

function headerNames(raw){
 const head=raw.slice(0,raw.indexOf('\r\n\r\n'));
 return head.split('\r\n').slice(1).filter(Boolean).map(line=>line.split(':')[0]);
}

function listen(server){
 return new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{
   server.off('error',reject);
   resolve(server.address().port);
  });
 });
}

test('Grok/Gemini 不走伪造栈，Claude/Codex 才走',()=>{
 assert.equal(defaultFetchFor('official-grok'),fetch);
 assert.equal(defaultFetchFor('official-gemini'),fetch);
 assert.equal(defaultFetchFor('official-claude'),claudeOAuthFetch);
 assert.equal(defaultFetchFor('official-codex'),codexOAuthFetch);
 assert.equal(cpaOAuthSpec('official-grok',{}).extraRequestHeaders,undefined);
 assert.equal(cpaOAuthSpec('official-gemini',{}).extraRequestHeaders,undefined);
 assert.equal(cpaOAuthSpec('official-claude',{}).extraRequestHeaders['User-Agent'],CLAUDE_OAUTH_USER_AGENT);
 assert.equal(cpaOAuthSpec('official-codex',{}).extraRequestHeaders.Originator,CODEX_CLI_ORIGINATOR);
});

test('Claude TLS 选项是 Node/OpenSSL 1.2–1.3，且不带 ALPN',()=>{
 const options=claudeOAuthTlsConnectOptions({host:'platform.claude.com',ALPNProtocols:['h2','http/1.1']});
 assert.equal(options.minVersion,'TLSv1.2');
 assert.equal(options.maxVersion,'TLSv1.3');
 assert.equal(options.ALPNProtocols,undefined);
 assert.match(options.ciphers,/TLS_AES_128_GCM_SHA256/);
 assert.equal(options.ciphers,CLAUDE_OAUTH_CIPHERS);
 assert.match(options.ecdhCurve,/X25519/);
 assert.match(options.sigalgs,/ecdsa_secp256r1_sha256/);
 tls.createSecureContext(options);
});

test('HTTP/1.1 请求头按官方顺序重排并改回 Axios 大小写',()=>{
 const raw=[
  'POST /v1/oauth/token HTTP/1.1',
  'host: platform.claude.com',
  'connection: close',
  'content-type: application/json',
  'accept: application/json, text/plain, */*',
  'user-agent: axios/1.15.2',
  'accept-encoding: gzip, compress, deflate, br',
  'content-length: 2',
  '',
  '{}',
 ].join('\r\n');
 const ordered=orderHttp1RequestHeaders(Buffer.from(raw,'latin1'),CLAUDE_OAUTH_HEADER_ORDER).toString('latin1');
 assert.deepEqual(headerNames(ordered),['Accept','Content-Type','User-Agent','Content-Length','Accept-Encoding','Host','Connection']);
 assert.match(ordered,/User-Agent: axios\/1\.15\.2/);
 assert.match(ordered,/\r\n\r\n\{\}$/);
});

function teeHttpServer(onRequest){
 const server=http.createServer((req,res)=>{
  const chunks=[];
  req.on('data',chunk=>chunks.push(chunk));
  req.on('end',()=>{
   server._lastRaw=req.socket._raw||'';
   onRequest?.(req,res,Buffer.concat(chunks));
  });
 });
 server.on('connection',socket=>{
  socket.on('data',chunk=>{socket._raw=(socket._raw||'')+chunk.toString('latin1');});
 });
 return server;
}

test('Claude impersonating fetch 使用 HTTP/1.1、axios UA 和官方请求头顺序',async()=>{
 const server=teeHttpServer((req,res)=>{
  assert.equal(req.httpVersion,'1.1');
  assert.equal(req.headers['user-agent'],CLAUDE_OAUTH_USER_AGENT);
  assert.equal(req.headers.accept,CLAUDE_OAUTH_ACCEPT);
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end('{"token":"ok"}');
 });
 const port=await listen(server);
 try{
  const result=await claudeOAuthFetch(`http://127.0.0.1:${port}/v1/oauth/token`,{
   method:'POST',
   headers:{'content-type':'application/json',accept:'application/json'},
   body:'{"grant_type":"refresh_token"}',
   redirect:'error',
  });
  assert.equal(result.ok,true);
  assert.equal((await result.json()).token,'ok');
 }finally{
  server.close();
 }
 const raw=server._lastRaw;
 assert.match(raw,/^POST \/v1\/oauth\/token HTTP\/1\.1\r\n/);
 assert.deepEqual(headerNames(raw),CLAUDE_OAUTH_HEADER_ORDER);
 assert.match(raw,new RegExp(`User-Agent: ${CLAUDE_OAUTH_USER_AGENT}`));
 assert.match(raw,new RegExp(`Accept: ${CLAUDE_OAUTH_ACCEPT.replace(/[*/]/g,'\\$&')}`));
 assert.match(raw,new RegExp(`Accept-Encoding: ${CLAUDE_OAUTH_ACCEPT_ENCODING}`));
 assert.match(raw,/Connection: close/);
});

test('Codex impersonating fetch 带官方 rust CLI User-Agent 和 Originator',async()=>{
 const server=teeHttpServer((req,res)=>{
  assert.equal(req.headers['user-agent'],CODEX_CLI_USER_AGENT);
  assert.equal(req.headers.originator,CODEX_CLI_ORIGINATOR);
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end('{"token":"ok"}');
 });
 const port=await listen(server);
 try{
  const result=await codexOAuthFetch(`http://127.0.0.1:${port}/oauth/token`,{
   method:'POST',
   headers:{'content-type':'application/x-www-form-urlencoded'},
   body:'grant_type=refresh_token',
  });
  assert.equal((await result.json()).token,'ok');
 }finally{
  server.close();
 }
 const raw=server._lastRaw;
 assert.deepEqual(headerNames(raw),CODEX_OAUTH_HEADER_ORDER);
 assert.match(raw,/User-Agent: codex_cli_rs\/0\.154\.0 \(Mac OS 26\.5\.2; arm64\) iTerm\.app\/3\.6\.11/);
 assert.match(raw,/Originator: codex_cli_rs/);
});

test('Claude impersonating fetch 解压 gzip JSON',async()=>{
 const payload=zlib.gzipSync(Buffer.from('{"access_token":"claude-at"}'));
 const server=http.createServer((_req,res)=>{
  res.writeHead(200,{
   'Content-Type':'application/json',
   'Content-Encoding':'gzip',
   'Content-Length':payload.length,
  });
  res.end(payload);
 });
 const port=await listen(server);
 try{
  const res=await claudeOAuthFetch(`http://127.0.0.1:${port}/v1/oauth/token`,{
   method:'POST',
   headers:{'content-type':'application/json'},
   body:'{}',
  });
  assert.equal((await res.json()).access_token,'claude-at');
 }finally{
  server.close();
 }
});

test('extra*Headers 与伪造常量一致',()=>{
 assert.equal(extraClaudeOAuthHeaders()['User-Agent'],CLAUDE_OAUTH_USER_AGENT);
 assert.equal(extraCodexOAuthHeaders()['User-Agent'],CODEX_CLI_USER_AGENT);
 assert.equal(extraCodexOAuthHeaders().Originator,CODEX_CLI_ORIGINATOR);
});
