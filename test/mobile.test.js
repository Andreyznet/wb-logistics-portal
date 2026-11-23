import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {createPortal,seedPreviewDemo} from '../src/server.js';
import {mobileSync} from '../src/mobile.js';
test('Android feed keeps durable state changes, isolates alerts, strips technical details for logist',()=>{
 const store=openStore(':memory:');try{
  seedPreviewDemo(store);const users=store.users(),admin=users.find(u=>u.role==='super_admin'),logist=users.find(u=>u.role==='logist');
  const initial=mobileSync(store,logist,{});assert.equal(initial.events.length,0);
  store.recordBotLog('bot_enabled',{message:'Бот запущен.'});
  store.recordBotLog('api_error',{message:'private-endpoint-marker'});
  store.recordBotLog('bot_disabled',{message:'Бот остановлен.'});
  const own=store.db.prepare('INSERT INTO acceptance_alerts(user_id,request_id,payload,created_at) VALUES(?,?,?,?)');
  own.run(admin.id,99999,JSON.stringify({id:'admin-secret'}),new Date().toISOString());own.run(logist.id,88888,JSON.stringify({id:'own-alert'}),new Date().toISOString());
  const result=mobileSync(store,logist,{since:initial.cursor});assert.deepEqual(result.events.map(e=>e.kind),['bot_enabled','api_error','bot_disabled']);assert.equal(result.alerts.length,1);assert.equal(result.alerts[0].payload.id,'own-alert');assert.ok(!JSON.stringify(result).includes('private-endpoint-marker'));assert.ok(!JSON.stringify(result).includes('admin-secret'));
  assert.ok(JSON.stringify(mobileSync(store,admin,{since:initial.cursor})).includes('private-endpoint-marker'));
  assert.equal(mobileSync(store,logist,{since:result.cursor}).events.length,0);
  assert.throws(()=>mobileSync(store,logist,{since:'bad'}));
  store.acknowledgeAlert(result.alerts[0].id,logist);assert.equal(mobileSync(store,logist,{}).alerts.length,0);
 }finally{store.close();}
});
test('Android sync authenticates through the portal cookie and rejects an invalid cursor',async()=>{
 const store=openStore(':memory:');seedPreviewDemo(store);const server=createPortal({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port+'/portal-api/mobile/sync';
 try{assert.equal((await fetch(url)).status,401);for(const user of store.users()){const headers={Cookie:'portal_session='+store.createSession(user.id)};const response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal((await response.json()).user.id,user.id);assert.equal((await fetch(url+'?since=bad',{headers})).status,400);}}
 finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
