import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {createPortal,seedPreviewDemo} from '../src/server.js';
import {mobileSync,initMobile,connectMobile,mobileDevice,ackMobile} from '../src/mobile.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('portal notifies Android about completed login and logout without sending cookies or passwords to JavaScript bridge',()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),calls=[];
 const context=vm.createContext({state:{user:{id:7}},window:{MarshrutSession:{signedIn:id=>calls.push(id),signedOut:()=>calls.push('out')}}});
 vm.runInContext(source.slice(source.indexOf('function syncAndroidSession()'),source.indexOf('async function boot()')),context);
 vm.runInContext('syncAndroidSession();state.user=null;syncAndroidSession()',context);assert.deepEqual(calls,['7','out']);
});
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

test('each phone receives test alert even after PC acknowledges; phone receipts are independent and tokens are revocable',()=>{
 const store=openStore(':memory:');try{
  seedPreviewDemo(store);initMobile(store);const admin=store.users().find(u=>u.role==='super_admin');
  const first=connectMobile(store,admin,'installation-phone-111'),second=connectMobile(store,admin,'installation-phone-222');
  const a=mobileDevice(store,'Bearer '+first.token),b=mobileDevice(store,'Bearer '+second.token);
  assert.ok(a&&b);assert.notEqual(first.token,second.token);assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM mobile_devices').all()).includes(first.token));
  const alert=store.createTestAlert(null,admin);store.acknowledgeAlert(alert.id,admin);
  assert.equal(store.userAlerts(admin).length,0);
  assert.ok(mobileSync(store,admin,{},a).alerts.some(x=>x.id===alert.id));assert.ok(mobileSync(store,admin,{},b).alerts.some(x=>x.id===alert.id));
  ackMobile(store,admin,a,alert.id);assert.equal(mobileSync(store,admin,{},a).alerts.length,0);assert.equal(mobileSync(store,admin,{},b).alerts.length,1);
  const rotated=connectMobile(store,admin,'installation-phone-111');assert.equal(mobileDevice(store,'Bearer '+first.token),null);assert.ok(mobileDevice(store,'Bearer '+rotated.token));
  const logist=store.users().find(u=>u.role==='logist');assert.throws(()=>ackMobile(store,logist,b,alert.id));
  connectMobile(store,logist,'installation-phone-222');assert.equal(mobileDevice(store,'Bearer '+second.token),null);
 }finally{store.close();}
});
test('device bearer is scoped to mobile APIs, cannot register devices or access portal administration',async()=>{
 const store=openStore(':memory:');seedPreviewDemo(store);const server=createPortal({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{
  const admin=store.users().find(u=>u.role==='super_admin'),cookie='portal_session='+store.createSession(admin.id);
  const register=await fetch(origin+'/portal-api/mobile/connect',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({installationId:'test-phone-installation'})});assert.equal(register.status,200);
  const pair=await register.json(),headers={Authorization:'Bearer '+pair.token};
  const sync=await fetch(origin+'/portal-api/mobile/sync',{headers});assert.equal(sync.status,200);assert.equal((await sync.json()).user.id,admin.id);
  assert.equal((await fetch(origin+'/portal-api/bot/settings',{headers})).status,401);
  assert.equal((await fetch(origin+'/portal-api/mobile/connect',{method:'POST',headers:{...headers,Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/portal-api/mobile/disconnect',{method:'POST',headers:{...headers,Origin:origin}})).status,200);
  assert.equal((await fetch(origin+'/portal-api/mobile/sync',{headers})).status,401);
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
test('Android sync authenticates through the portal cookie and rejects an invalid cursor',async()=>{
 const store=openStore(':memory:');seedPreviewDemo(store);const server=createPortal({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port+'/portal-api/mobile/sync';
 try{assert.equal((await fetch(url)).status,401);for(const user of store.users()){const headers={Cookie:'portal_session='+store.createSession(user.id)};const response=await fetch(url,{headers});assert.equal(response.status,200);assert.equal((await response.json()).user.id,user.id);assert.equal((await fetch(url+'?since=bad',{headers})).status,400);}}
 finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
