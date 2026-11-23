import test from 'node:test';
import assert from 'node:assert/strict';
import {knowledgeFor} from '../src/knowledge.js';
import {openStore} from '../src/store.js';
import {createPortal,seedPreviewDemo} from '../src/server.js';
test('knowledge inherits instructions by role and keeps token and diagnostics guides out of logist response',()=>{
 const logist=knowledgeFor('logist'),manager=knowledgeFor('admin'),admin=knowledgeFor('super_admin');
 assert.ok(logist.some(a=>a.id==='create'));assert.ok(logist.some(a=>a.id==='watch'));
 assert.ok(!logist.some(a=>a.id==='token'));assert.ok(manager.some(a=>a.id==='token'&&a.steps.length>=7));
 assert.ok(!manager.some(a=>a.id==='admin-diagnostics'));assert.ok(admin.some(a=>a.id==='admin-diagnostics'));
 for(const role of ['logist','admin','super_admin']){const rows=knowledgeFor(role);assert.equal(new Set(rows.map(a=>a.id)).size,rows.length);assert.ok(rows.every(a=>a.paragraphs.length>0));}
 assert.deepEqual(knowledgeFor('unknown'),[]);
});
test('knowledge API requires session and serves matching role instructions and browser script',async()=>{
 const store=openStore(':memory:');seedPreviewDemo(store);const server=createPortal({store});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(origin+'/portal-api/knowledge')).status,401);
  for(const user of store.users()){
   const response=await fetch(origin+'/portal-api/knowledge',{headers:{Cookie:'portal_session='+store.createSession(user.id)}});
   assert.equal(response.status,200);assert.deepEqual((await response.json()).data,knowledgeFor(user.role));
  }
  const script=await fetch(origin+'/knowledge.js');assert.equal(script.status,200);assert.match(await script.text(),/async function renderKnowledge/);
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
