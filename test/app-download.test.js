import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {openStore} from '../src/store.js';
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
