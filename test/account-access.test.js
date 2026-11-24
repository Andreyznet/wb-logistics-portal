import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {createPortal,seedPreviewDemo} from '../src/server.js';
import {initMobile,connectMobile,mobileDevice,mobileSync,waitMobile} from '../src/mobile.js';
import {initFcm,registerPush,FcmDispatcher} from '../src/fcm.js';
import {blockAccount,listDevices} from '../src/account-access.js';

test('blocking revokes browser and all device credentials, cancels an outstanding wait and requires fresh login after unblock',async()=>{
 const store=openStore(':memory:');try{
  seedPreviewDemo(store);initMobile(store);initFcm(store);const users=store.users(),root=users.find(u=>u.role==='super_admin'),user=users.find(u=>u.role==='logist');
  const cookie=store.createSession(user.id),a=connectMobile(store,user,'blocked-phone-first'),b=connectMobile(store,user,'blocked-phone-second');
  const device=mobileDevice(store,'Bearer '+a.token),initial=mobileSync(store,user,{},device),controller=new AbortController();
  const pending=waitMobile(store,user,{since:initial.cursor,revision:initial.revision,wait:25},device,controller.signal);
  blockAccount(store,user.id,true,root);await assert.rejects(pending,e=>e.status===401);
  assert.equal(store.session(cookie),null);assert.equal(mobileDevice(store,'Bearer '+a.token),null);assert.equal(mobileDevice(store,'Bearer '+b.token),null);
  assert.throws(()=>store.login('dmitry.v','logist2026demo'),e=>e.status===403);assert.throws(()=>connectMobile(store,user,'another-blocked-phone'),e=>e.status===403);
  blockAccount(store,user.id,false,root);assert.equal(store.login('dmitry.v','logist2026demo').id,user.id);assert.equal(store.session(cookie),null);assert.equal(mobileDevice(store,'Bearer '+a.token),null);
  const renewed=connectMobile(store,user,'blocked-phone-first');assert.ok(mobileDevice(store,'Bearer '+renewed.token));assert.notEqual(renewed.token,a.token);
 }finally{store.close();}
});

test('manager can block staff; device presence is administrator-only and protected accounts cannot be blocked',async()=>{
 const store=openStore(':memory:');seedPreviewDemo(store);const server=createPortal({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port,users=store.users(),root=users.find(u=>u.role==='super_admin'),manager=users.find(u=>u.role==='admin'),user=users.find(u=>u.role==='logist');
 const cookies=new Map(users.map(u=>[u.id,'portal_session='+store.createSession(u.id)]));
 const call=(u,path,data)=>fetch(origin+'/portal-api'+path,{method:data?'POST':'GET',headers:{Cookie:cookies.get(u.id),Origin:origin,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
 try{
  const pair=connectMobile(store,user,'sanitized-phone-test',{deviceName:'Test phone',appVersion:'1.1.1'}),auth={Authorization:'Bearer '+pair.token,Origin:origin,'Content-Type':'application/json'};
  assert.equal((await fetch(origin+'/portal-api/mobile/heartbeat',{method:'POST',headers:auth,body:'{"foreground":true}'})).status,200);
  const response=await call(root,'/admin/devices');assert.equal(response.status,200);const devices=await response.json();assert.equal(devices.data[0].device_name,'Test phone');assert.equal(devices.data[0].foreground,1);assert.ok(devices.data[0].last_ui_at);assert.ok(!JSON.stringify(devices).includes(pair.token));assert.ok(!Object.hasOwn(devices.data[0],'token_hash'));
  for(const u of [manager,user])assert.equal((await call(u,'/admin/devices')).status,403);
  assert.equal((await call(user,'/admin/users/'+manager.id+'/block',{blocked:true})).status,403);
  assert.equal((await call(manager,'/admin/users/'+user.id+'/block',{blocked:true})).status,200);
  assert.equal((await call(manager,'/admin/users/'+user.id+'/block',{blocked:false})).status,200);
  assert.equal((await call(manager,'/admin/users/'+manager.id+'/block',{blocked:true})).status,403);
  assert.equal((await call(manager,'/admin/users/'+root.id+'/block',{blocked:true})).status,403);
  const peer=store.addUser({username:'peer.manager',name:'Peer manager',password:'long-password-123',role:'admin'},root),peerSession=store.createSession(peer.id);
  assert.equal((await call(manager,'/admin/users/'+peer.id+'/block',{blocked:true})).status,200);assert.equal(store.session(peerSession),null);
  assert.equal((await call(manager,'/admin/users/'+peer.id+'/block',{blocked:false})).status,200);
  assert.equal((await call(root,'/admin/users/'+root.id+'/block',{blocked:true})).status,403);
  assert.equal((await call(root,'/admin/users/'+user.id+'/block',{blocked:'true'})).status,400);
  assert.equal((await call(root,'/admin/users/'+user.id+'/block',{blocked:true})).status,200);
  assert.equal((await call(user,'/requests')).status,401);assert.equal((await fetch(origin+'/portal-api/mobile/sync',{headers:auth})).status,401);
  assert.equal(listDevices(store,root)[0].revoked_at!=null,true);
 }finally{await new Promise(r=>server.close(r));store.close();}
});

test('revocation push bypasses disabled notifications, contains the old credential fingerprint, and cannot target a renewed session',async()=>{
 const store=openStore(':memory:');try{
  seedPreviewDemo(store);initMobile(store);initFcm(store);const root=store.users().find(u=>u.role==='super_admin'),user=store.users().find(u=>u.role==='logist');
  const pair=connectMobile(store,user,'revocation-fcm-phone'),device=mobileDevice(store,'Bearer '+pair.token);
  registerPush(store,device,{token:'revoked-device-fcm-token',enabled:false});
  const sent=[],worker=new FcmDispatcher(store,{send:async(token,data)=>sent.push({token,data})});
  blockAccount(store,user.id,true,root);await worker.tick();assert.equal(sent.length,1);assert.equal(sent[0].data.kind,'access_revoked');assert.equal(sent[0].data.accessHash,device.token_hash);assert.ok(!JSON.stringify(sent).includes(pair.token));
  blockAccount(store,user.id,false,root);const renewed=connectMobile(store,user,'revocation-fcm-phone');
  store.db.prepare('UPDATE fcm_outbox SET sent_at=NULL WHERE kind=?').run('access_revoked');await worker.tick();assert.equal(sent.length,1);assert.ok(mobileDevice(store,'Bearer '+renewed.token));
 }finally{store.close();}
});
