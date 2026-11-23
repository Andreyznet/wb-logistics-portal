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
 const token=manager.find(a=>a.id==='token');assert.match(token.steps[3],/главной странице/);assert.match(token.steps[3],/user-management\/api\/v2\/public\/user\/profile/);assert.match(token.steps[2],/Fetch\/XHR/);assert.match(token.steps[4],/Request headers/);assert.match(token.steps[5],/Copy value/);assert.equal(token.illustrations[0].step,6);assert.ok(!JSON.stringify(token).includes('token/merge'));
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
  const image=await fetch(origin+'/help/token-authorization.png');assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');const bytes=new Uint8Array(await image.arrayBuffer());assert.deepEqual([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
