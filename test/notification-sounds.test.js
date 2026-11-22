import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {createPortal} from '../src/server.js';
import {notificationSounds} from '../src/notification-sounds.js';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
test('sound preferences are personal, validated and persist across restart without changing roles',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'portal-sound-')),file=join(dir,'db.sqlite');let store=openStore(file);
 try{const admin=store.addUser({username:'root',name:'Root',password:'testing-password-123'},null,true),logist=store.addUser({username:'logist',name:'Logist',password:'testing-password-123',role:'logist'},admin);
 assert.deepEqual(store.notificationSettings(logist.id),{soundId:'digital-alarm',volume:80});
 store.saveNotificationSettings({soundId:'police-siren',volume:95,userId:admin.id},logist);
 assert.equal(store.notificationSettings(admin.id).soundId,'digital-alarm');assert.equal(store.login('logist','testing-password-123').notificationSettings.soundId,'police-siren');
 for(const input of [null,{}, {soundId:'../secret',volume:80},{soundId:'digital-alarm',volume:0},{soundId:'digital-alarm',volume:101},{soundId:'digital-alarm',volume:20.5}])assert.throws(()=>store.saveNotificationSettings(input,logist));
 store.close();store=openStore(file);assert.deepEqual(store.notificationSettings(logist.id),{soundId:'police-siren',volume:95});assert.equal(store.login('logist','testing-password-123').role,'logist');
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('every logged-in role can change only its own sound; local audio is served with correct MIME',async()=>{
 const store=openStore(':memory:'),root=store.addUser({username:'root',name:'Root',password:'testing-password-123'},null,true);const users=[root,...['admin','logist'].map(role=>store.addUser({username:role,name:role,password:'testing-password-123',role},root))];
 const server=createPortal({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{
 assert.equal((await fetch(origin+'/api/me/notification-settings')).status,401);
 for(const user of users){const headers={Cookie:'portal_session='+store.createSession(user.id),'Content-Type':'application/json',Origin:origin};const saved=await fetch(origin+'/api/me/notification-settings',{method:'POST',headers,body:JSON.stringify({soundId:'classic-alarm',volume:75})});assert.equal(saved.status,200);const body=await(await fetch(origin+'/api/me/notification-settings',{headers})).json();assert.equal(body.settings.soundId,'classic-alarm');assert.equal(body.sounds.length,6);}
 for(const sound of notificationSounds){const response=await fetch(origin+sound.url);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^audio\//);assert.ok((await response.arrayBuffer()).byteLength>1000);}
 assert.equal((await fetch(origin+'/sounds/secret.wav')).status,404);assert.equal((await fetch(origin+'/notification-audio.js')).status,200);
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
async function audioHarness(){const sources=[],gains=[];let resolveFetch;const context={state:'running',resume:async()=>{},destination:{},decodeAudioData:async()=>({duration:2}),createBufferSource:()=>{const source={connect:()=>({connect:()=>{}}),disconnect(){},start(){this.started=true;},stop(){this.stopped=true;}};sources.push(source);return source;},createGain:()=>{const gain={gain:{value:0},disconnect(){}};gains.push(gain);return gain;}};const scope=vm.createContext({window:{AudioContext:function(){return context;}},fetch:()=>new Promise(resolve=>{resolveFetch=resolve;})});const source=await readFile(new URL('../public/notification-audio.js',import.meta.url),'utf8');vm.runInContext(source+';globalThis.player=new NotificationAudioPlayer();',scope);return {scope,sources,gains,resolve:()=>resolveFetch({ok:true,arrayBuffer:async()=>new ArrayBuffer(4)})};}
test('looping player stops immediately, caches decoded audio and applies personal volume without overlap',async()=>{
 const h=await audioHarness();const first=vm.runInContext("player.play('/sounds/test.ogg',70,{loop:true})",h.scope);await new Promise(setImmediate);h.resolve();assert.equal(await first,true);assert.equal(h.sources[0].loop,true);assert.equal(h.gains[0].gain.value,.7);
 await vm.runInContext("player.play('/sounds/test.ogg',30,{loop:true})",h.scope);assert.equal(h.sources[0].stopped,true);assert.equal(h.sources.length,2);assert.equal(h.gains[1].gain.value,.3);vm.runInContext('player.stop()',h.scope);assert.equal(h.sources[1].stopped,true);
});
test('late audio download cannot start after alert acknowledgement or preview close',async()=>{
 const h=await audioHarness(),pending=vm.runInContext("player.play('/sounds/test.ogg',80,{loop:true})",h.scope);await new Promise(setImmediate);vm.runInContext('player.stop()',h.scope);h.resolve();assert.equal(await pending,false);assert.equal(h.sources.length,0);
});
