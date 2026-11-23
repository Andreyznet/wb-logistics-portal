import test from 'node:test';
import assert from 'node:assert/strict';
import {monitoredFetch} from '../src/api-monitor.js';
import {openStore} from '../src/store.js';
import {dashboard} from '../src/dashboard.js';
import {seedPreviewDemo} from '../src/server.js';

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
