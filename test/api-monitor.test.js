import test from 'node:test';
import assert from 'node:assert/strict';
import {monitoredFetch} from '../src/api-monitor.js';
import {openStore} from '../src/store.js';
import {dashboard} from '../src/dashboard.js';
import {seedPreviewDemo} from '../src/server.js';
import {mobileSync} from '../src/mobile.js';
import {makeDirectoryApi} from '../src/directory-api.js';

test('transient catalog 503 is retried and journaled without incident or push; sustained errors and authorization failures do notify',async()=>{
 const store=openStore(':memory:');try{
  seedPreviewDemo(store);const admin=store.users().find(u=>u.role==='super_admin');
  const baseline=mobileSync(store,admin,{}).cursor;let calls=0;
  const api=makeDirectoryApi({logisticsHeaders:{},driveHeaders:{}},monitoredFetch(store,async()=>{calls++;return new Response('{}',{status:calls===1?503:200,headers:{'Content-Type':'application/json'}});}));
  await api.routecars({data:{query:'61373'}});assert.equal(calls,2);
  let sync=mobileSync(store,admin,{since:baseline});assert.equal(sync.events.length,0);assert.equal(sync.bot.apiErrors,0);
  assert.ok(store.getBotStatus(admin).logs.some(e=>e.kind==='api_error'&&e.payload.httpStatus===503));
  const endpoint='POST https://logistics.wb.ru/router-bff/routecar/v1/routecars';
  store.recordApiHealth({endpoint,method:'POST',httpStatus:503,message:'temporary'});
  sync=mobileSync(store,admin,{since:baseline});assert.equal(sync.bot.apiErrors,0);
  assert.ok(!dashboard(store,admin).alerts.some(a=>a.title==='Ошибка API · HTTP 503'));
  const issues=store.getBotStatus(admin).runtime.apiIssues;issues[endpoint].firstSeenAt=new Date(Date.now()-35000).toISOString();issues[endpoint].count=2;store.setBotRuntime({apiIssues:issues});
  store.recordApiHealth({endpoint,method:'POST',httpStatus:503,message:'still unavailable'});
  sync=mobileSync(store,admin,{since:baseline});assert.equal(sync.bot.apiErrors,1);assert.equal(sync.events.filter(e=>e.kind==='api_error').length,1);
  const cursor=sync.cursor;store.recordApiHealth({endpoint,method:'POST',httpStatus:503,message:'still unavailable'});assert.equal(mobileSync(store,admin,{since:cursor}).events.length,0);
  store.recordApiHealth({endpoint,method:'POST',httpStatus:200,message:'restored'});assert.equal(mobileSync(store,admin,{since:cursor}).events[0].kind,'api_recovered');
  store.recordApiHealth({endpoint,method:'POST',httpStatus:401,message:'authorization denied'});assert.equal(mobileSync(store,admin,{}).bot.apiErrors,1);
 }finally{store.close();}
});

test('API failures persist per endpoint, are visible by role, and recover independently',async()=>{
 const store=openStore(':memory:');
 try{
  seedPreviewDemo(store);
  let status=503;
  const fetcher=monitoredFetch(store,async()=>new Response('{}',{status}));
  const a='https://logistics.wb.ru/transport-requests-service/api/v1/transport-requests/123';
  const b='https://drive.wb.ru/user-management/api/v1/public/user-partnerships/drivers/list';
  await fetcher(a);status=429;await fetcher(b,{method:'POST'});
  const users=store.users(),admin=users.find(u=>u.role==='super_admin'),logist=users.find(u=>u.role==='logist');
  assert.equal(Object.keys(store.getBotStatus(admin).runtime.apiIssues).length,2);
  assert.ok(dashboard(store,admin).alerts.some(a=>a.title.includes('503')));
  assert.ok(dashboard(store,logist).alerts.some(a=>a.title.includes('503')));
  assert.ok(!JSON.stringify(dashboard(store,logist)).includes('drive.wb.ru'));
  status=200;await fetcher(a.replace('123','456'));
  assert.equal(Object.keys(store.getBotStatus(admin).runtime.apiIssues).length,1);
  await fetcher(b,{method:'POST'});
  assert.equal(Object.keys(store.getBotStatus(admin).runtime.apiIssues).length,0);
  assert.equal(store.getBotStatus(admin).logs.filter(e=>e.kind==='api_recovered').length,2);
 }finally{store.close();}
});
test('network failure is reported, cancellation is ignored, and PUT is never retried',async()=>{
 const reports=[];let calls=0;
 const fetcher=monitoredFetch({recordApiHealth:x=>reports.push(x)},async()=>{calls++;throw new Error('secret must not leak');});
 await assert.rejects(fetcher('https://example.com/take',{method:'PUT'}));
 assert.equal(calls,1);assert.equal(reports[0].httpStatus,0);assert.ok(!reports[0].message.includes('secret'));
 const c=new AbortController();c.abort();await assert.rejects(fetcher('https://example.com/take',{signal:c.signal}));
 assert.equal(reports.length,1);
});
