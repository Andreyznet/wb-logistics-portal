import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {openStore} from '../src/store.js';
import {connectMobile} from '../src/mobile.js';
import {createPortal,seedPreviewDemo} from '../src/server.js';
test('APK downloads only for administrator; anonymous users, managers and logists cannot access the direct URL',async()=>{
 const store=openStore(':memory:');seedPreviewDemo(store);const server=createPortal({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port,apk=await readFile(new URL('../public/downloads/marshrut.apk',import.meta.url));
 try{
  for(const user of [null,...store.users()]){
   const headers=user?{Cookie:'portal_session='+store.createSession(user.id)}:{};
   const response=await fetch(origin+'/downloads/marshrut.apk',{headers});
   if(!user||user.role!=='super_admin'){assert.equal(response.status,user?403:401);assert.ok(response.headers.get('content-type').includes('application/json'));continue;}
   assert.equal(response.status,200);
   assert.equal(response.headers.get('content-type'),'application/vnd.android.package-archive');assert.equal(response.headers.get('content-disposition'),'attachment; filename="marshrut.apk"');
   const actual=Buffer.from(await response.arrayBuffer());assert.equal(actual.subarray(0,2).toString(),'PK');assert.equal(createHash('sha256').update(actual).digest('hex'),createHash('sha256').update(apk).digest('hex'));
  }
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});


test('in-app update metadata and APK require active device auth for every role; public download stays restricted',async()=>{
 const store=openStore(':memory:');seedPreviewDemo(store);const server=createPortal({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 try{
 for(const path of ['/api/mobile/app-update','/api/mobile/app-update/apk'])assert.equal((await fetch(origin+path)).status,401);
 for(const user of store.users()){
  const browser={Cookie:'portal_session='+store.createSession(user.id)};assert.equal((await fetch(origin+'/api/mobile/app-update',{headers:browser})).status,401);
  const pair=connectMobile(store,user,'update-device-'+user.id+'-installation'),headers={Authorization:'Bearer '+pair.token};
  const meta=await fetch(origin+'/api/mobile/app-update',{headers});assert.equal(meta.status,200);const data=await meta.json();assert.equal(data.versionCode,11);assert.equal(data.versionName,'1.1.7');assert.match(data.sha256,/^[a-f0-9]{64}$/);assert.equal(data.path,'mobile/app-update/apk');
  const response=await fetch(origin+'/portal-api/'+data.path,{headers});assert.equal(response.status,200);const apk=Buffer.from(await response.arrayBuffer());assert.equal(apk.length,data.size);assert.equal(createHash('sha256').update(apk).digest('hex'),data.sha256);
  store.db.prepare('UPDATE mobile_devices SET expires_at=0 WHERE user_id=?').run(user.id);assert.equal((await fetch(origin+'/api/mobile/app-update/apk',{headers})).status,401);
 }
 }finally{await new Promise(r=>server.close(r));store.close();}
});
