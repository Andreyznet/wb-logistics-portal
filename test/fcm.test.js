import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {seedPreviewDemo,createPortal} from '../src/server.js';
import {initMobile,connectMobile,mobileDevice} from '../src/mobile.js';
import {initFcm,registerPush,FcmDispatcher,googleSender} from '../src/fcm.js';
import {generateKeyPairSync,verify} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture(){
 const store=openStore(':memory:');seedPreviewDemo(store);initMobile(store);initFcm(store);
 const users=store.users(),owner=users.find(u=>u.role==='super_admin'),other=users.find(u=>u.role==='logist');
 const device=u=>mobileDevice(store,'Bearer '+connectMobile(store,u,'installation-for-user-'+u.id).token);
 const a=device(owner),b=device(other);
 registerPush(store,a,{token:'owner-fcm-registration-token',enabled:true});registerPush(store,b,{token:'other-fcm-registration-token',enabled:true});
 return {store,owner,other,a,b};
}
test('FCM fans out alerts to their recipients, survives browser acknowledgement and does not resend successful jobs',async()=>{
 const {store,owner}=fixture();try{
  const sent=[],worker=new FcmDispatcher(store,{send:async(token,data)=>sent.push({token,data})});
  const alert=store.createTestAlert(null,owner);store.acknowledgeAlert(alert.id,owner);
  store.recordBotLog('api_error',{notify:false,message:'temporary'});
  await worker.tick();await worker.tick();
  assert.deepEqual(sent,[{token:'owner-fcm-registration-token',data:{event:'alert:'+alert.id,kind:'alert'}}]);
  store.recordBotLog('bot_enabled',{message:'started'});store.recordBotLog('api_error',{notify:true,message:'private technical detail'});
  await worker.tick();assert.equal(sent.length,5);assert.ok(!JSON.stringify(sent).includes('private technical detail'));
 }finally{store.close();}
});
test('FCM retries transient failures and invalidates expired registration tokens',async()=>{
 const {store,owner,a}=fixture();try{
  let now=Date.now(),calls=0;
  const worker=new FcmDispatcher(store,{clock:()=>now,send:async()=>{calls++;if(calls===1)throw Error('temporary');}});
  store.createTestAlert(null,owner);await worker.tick();await worker.tick();assert.equal(calls,1);
  now+=3000;await worker.tick();await worker.tick();assert.equal(calls,2);
  store.createTestAlert(null,owner);worker.send=async()=>{const e=Error('expired');e.unregistered=true;throw e;};await worker.tick();
  assert.equal(store.db.prepare('SELECT push_token FROM mobile_devices WHERE id=?').get(a.id).push_token,null);
 }finally{store.close();}
});
test('FCM registration and disabled-device isolation are enforced by the API',async()=>{
 const {store,owner,a}=fixture(),server=createPortal({store,pushWorker:{enabled:true}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 try{
  const pair=connectMobile(store,owner,'installation-for-user-'+owner.id),url=origin+'/portal-api/mobile/push-token';
  const send=headers=>fetch(url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify({token:'owner-fcm-registration-token',enabled:false})});
  assert.equal((await send({Cookie:'portal_session='+store.createSession(owner.id)})).status,401);
  const response=await send({Authorization:'Bearer '+pair.token});assert.equal(response.status,200);assert.equal((await response.json()).configured,true);
  let count=0;const worker=new FcmDispatcher(store,{send:async()=>count++});store.createTestAlert(null,owner);await worker.tick();assert.equal(count,0);
  assert.throws(()=>registerPush(store,a,{token:'bad',enabled:true}));
 }finally{await new Promise(r=>server.close(r));store.close();}
});
test('HTTP v1 sender signs OAuth assertions, caches credentials and sends high priority data messages',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'marshrut-fcm-')),file=join(dir,'service-account.json');
 try{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  writeFileSync(file,JSON.stringify({type:'service_account',project_id:'test-project-123',client_email:'sender@test-project-123.iam.gserviceaccount.com',private_key:privateKey.export({format:'pem',type:'pkcs8'})}));
  let authCalls=0,messageCalls=0;
  const send=googleSender(file,null,async(url,options)=>{
   if(url.includes('oauth2.googleapis.com')){authCalls++;const jwt=options.body.get('assertion'),parts=jwt.split('.');assert.ok(verify('RSA-SHA256',Buffer.from(parts.slice(0,2).join('.')),publicKey,Buffer.from(parts[2],'base64url')));assert.equal(JSON.parse(Buffer.from(parts[1],'base64url')).scope,'https://www.googleapis.com/auth/firebase.messaging');return {ok:true,json:async()=>({access_token:'mock-access',expires_in:3600})};}
   messageCalls++;const {message}=JSON.parse(options.body);assert.equal(message.android.priority,'HIGH');assert.deepEqual(message.data,{event:'alert:123',kind:'alert'});assert.equal(options.headers.Authorization,'Bearer mock-access');return {ok:true,json:async()=>({name:'accepted'})};
  });
  await send('test-device',{event:'alert:123',kind:'alert'});await send('test-device',{event:'alert:123',kind:'alert'});assert.equal(authCalls,1);assert.equal(messageCalls,2);
 }finally{rmSync(file);rmdirSync(dir);}
});
