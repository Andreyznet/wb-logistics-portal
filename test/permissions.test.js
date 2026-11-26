import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.js';
import {createPortal,seedPreviewDemo} from '../src/server.js';
import {permissionMatrix,savePermissions,permissionsFor} from '../src/permissions.js';

test('permission defaults preserve administrator access, restrict history, and reject malformed or stale changes',()=>{
 const store=openStore(':memory:');try{
  seedPreviewDemo(store);const root=store.users().find(u=>u.role==='super_admin'),manager=store.users().find(u=>u.role==='admin');
  let data=permissionMatrix(store);assert.equal(data.matrix.admin.activity,false);assert.equal(data.matrix.logist.activity,false);assert.equal(data.matrix.super_admin.activity,true);
  assert.throws(()=>savePermissions(store,data,manager),e=>e.status===403);
  data.matrix.super_admin.users=false;assert.throws(()=>savePermissions(store,data,root),e=>e.status===400);
  data=permissionMatrix(store);data.matrix.logist.requests=false;assert.throws(()=>savePermissions(store,data,root),e=>e.status===400);
  data=permissionMatrix(store);const stale=structuredClone(data);data.matrix.admin['requests.edit']=false;
  savePermissions(store,data,root);assert.equal(permissionsFor(store,manager)['requests.edit'],false);
  assert.throws(()=>savePermissions(store,stale,root),e=>e.status===409);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM audit WHERE action='permissions_updated'").get().n,1);
 }finally{store.close();}
});

test('live HTTP permissions enforce grants and revocations for existing sessions without granting administrator powers',async()=>{
 const store=openStore(':memory:');seedPreviewDemo(store);const server=createPortal({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port,users=store.users(),root=users.find(u=>u.role==='super_admin'),manager=users.find(u=>u.role==='admin'),logist=users.find(u=>u.role==='logist');
 const cookies=new Map(users.map(u=>[u.id,'portal_session='+store.createSession(u.id)]));
 const call=(user,path,data)=>fetch(origin+'/portal-api'+path,{method:data?'POST':'GET',headers:{Cookie:cookies.get(user?.id)||'',Origin:origin,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
 try{
  for(const u of [manager,logist]){assert.equal((await call(u,'/activity')).status,403);assert.equal((await call(u,'/admin/permissions')).status,403);}
  assert.equal((await call(root,'/activity')).status,200);assert.equal((await call(null,'/admin/permissions')).status,401);
  let data=await (await call(root,'/admin/permissions')).json();
  data.matrix.logist.bot=true;data.matrix.logist['bot.manage']=true;data.matrix.logist['users.manage']=true;
  data.matrix.admin['requests.create']=false;data.matrix.admin['bot.manage']=false;
  assert.equal((await call(manager,'/admin/permissions',data)).status,403);
  assert.equal((await call(root,'/admin/permissions',data)).status,200);
  assert.equal((await call(manager,'/requests',{})).status,403);
  assert.equal((await call(manager,'/bot/settings',{enabled:false})).status,403);
  let response=await call(logist,'/bot/settings?summary=1');assert.equal(response.status,200);const settings=(await response.json()).settings;
  assert.equal((await call(logist,'/bot/settings',{...settings,token:'',enabled:false})).status,200);
  const newUser={username:'delegated-manager',name:'Delegated',password:'long-password-123',role:'admin'};
  assert.equal((await call(logist,'/users',newUser)).status,201);
  assert.equal((await call(logist,'/users',{...newUser,username:'forbidden-root',role:'super_admin'})).status,403);
  assert.equal((await call(logist,'/users/'+root.id,{name:'Changed administrator'})).status,403);
  assert.equal((await call(logist,'/admin/permissions',data)).status,403);
  data=await (await call(root,'/admin/permissions')).json();data.matrix.logist.bot=false;data.matrix.logist['bot.manage']=false;
  assert.equal((await call(root,'/admin/permissions',data)).status,200);
  assert.equal((await call(logist,'/bot/settings')).status,403);
  const access=await (await call(logist,'/access')).json();assert.equal(access.permissions.bot,false);
 }finally{await new Promise(r=>server.close(r));store.close();}
});


test('legacy manager bot permission is granted once and manager can save settings; later revocation persists',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'manager-bot-')),file=join(dir,'portal.sqlite');let store=openStore(file),server;
 try{
 seedPreviewDemo(store);const old=permissionMatrix(store).matrix;old.admin['bot.manage']=false;store.db.prepare("INSERT INTO settings(key,value) VALUES('role_permissions',?)").run(JSON.stringify(old));store.db.prepare("DELETE FROM settings WHERE key='manager_bot_access_v1'").run();store.close();store=openStore(file);
 const manager=store.users().find(u=>u.role==='admin');assert.equal(permissionsFor(store,manager)['bot.manage'],true);
 server=createPortal({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,headers={Cookie:'portal_session='+store.createSession(manager.id),Origin:origin,'Content-Type':'application/json'};
 const settings=await(await fetch(origin+'/api/bot/settings',{headers})).json();const saved=await fetch(origin+'/api/bot/settings',{method:'POST',headers,body:JSON.stringify({...settings.settings,requestsPerMinute:12})});assert.equal(saved.status,200);assert.equal((await saved.json()).settings.requestsPerMinute,12);
 const matrix=permissionMatrix(store);matrix.matrix.admin['bot.manage']=false;savePermissions(store,matrix,store.users().find(u=>u.role==='super_admin'));
 assert.equal((await fetch(origin+'/api/bot/settings',{method:'POST',headers,body:JSON.stringify(settings.settings)})).status,403);
 await new Promise(r=>server.close(r));server=null;store.close();store=openStore(file);assert.equal(permissionsFor(store,manager)['bot.manage'],false);
 }finally{if(server)await new Promise(r=>server.close(r));store.close();await rm(dir,{recursive:true,force:true});}
});
