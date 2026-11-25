import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {openStore} from '../src/store.js';
import {createPortal} from '../src/server.js';

test('activity renews session and cookie, background reads do not, expired sessions cannot revive',async()=>{
 const store=openStore(':memory:'),user=store.addUser({username:'root',name:'Root',password:'testing-password-123'},null,true),token=store.createSession(user.id);
 const server=createPortal({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const headers={Cookie:'portal_session='+token,Origin:origin,'Content-Type':'application/json'};
 try{
 const old=Date.now()+3600000;store.db.prepare('UPDATE sessions SET expires_at=?').run(old);
 for(const path of ['/api/session','/api/me/alerts']){const res=await fetch(origin+path,{headers});assert.equal(res.status,200);assert.equal(Number(res.headers.get('X-Session-Expires-At')),old);assert.equal(res.headers.get('set-cookie'),null);}
 assert.equal(store.sessionExpiresAt(token),old);
 const renewed=await fetch(origin+'/api/session/activity',{method:'POST',headers,body:'{}'});assert.equal(renewed.status,200);const data=await renewed.json();assert.ok(data.sessionExpiresAt>=Date.now()+86400000-2000);assert.match(renewed.headers.get('set-cookie'),/Max-Age=86400/);assert.equal(store.sessionExpiresAt(token),data.sessionExpiresAt);
 assert.equal((await fetch(origin+'/api/session/activity',{method:'POST',headers:{...headers,Origin:'https://foreign.invalid'},body:'{}'})).status,403);
 store.db.prepare('UPDATE sessions SET expires_at=?').run(Date.now()-1);assert.equal(store.renewSession(token),null);assert.equal((await fetch(origin+'/api/session/activity',{method:'POST',headers,body:'{}'})).status,401);
 const blocked=store.createSession(user.id);store.db.prepare('UPDATE users SET blocked=1 WHERE id=?').run(user.id);assert.equal(store.renewSession(blocked),null);assert.equal(store.session(blocked),null);
 }finally{await new Promise(r=>server.close(r));store.close();}
});

test('trusted user input renews session; timers, hidden tabs and synthetic events do not',async()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');let now=100000,calls=0,interval;
 const state={user:{id:1},session:{sessionExpiresAt:now+86400000}},document={hidden:false,addEventListener(){},querySelector(){return null;}};
 const c=vm.createContext({state,document,Date:{now:()=>now},setInterval:fn=>{interval=fn;},api:async()=>{calls++;return {sessionExpiresAt:now+86400000};}});
 vm.runInContext(source.slice(source.indexOf('// Only trusted interaction'),source.indexOf('// End session activity')),c);
 interval();assert.equal(calls,0);vm.runInContext('recordSessionActivity({isTrusted:false})',c);assert.equal(calls,0);
 vm.runInContext('recordSessionActivity({isTrusted:true})',c);await new Promise(r=>setImmediate(r));assert.equal(calls,1);
 now+=61000;interval();assert.equal(calls,1,'polling with no new interaction does not prolong login');
 document.hidden=true;vm.runInContext('recordSessionActivity({isTrusted:true})',c);assert.equal(calls,1);
 document.hidden=false;vm.runInContext('recordSessionActivity({isTrusted:true})',c);await new Promise(r=>setImmediate(r));assert.equal(calls,2);
});
