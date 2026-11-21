import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, businessDate } from '../src/store.js';
import { createPortal } from '../src/server.js';

const directory={transport:{
  drivers:[{id:11,name:'Водитель Один'},{id:12,name:'Водитель Два'}],
  vehicles:[{id:21,name:'Тягач А',number_plate:'А001АА'},{id:22,name:'Тягач Б',number_plate:'Б002ББ'}],
  trailers:[{id:31,name:'Прицеп',number_plate:'П001'}],
}};
const input=(extra={})=>({routeId:61373,serviceDate:businessDate(),driverId:11,vehicleId:21,trailerId:31,priority:1,note:'План',...extra});
const setup=store=>{const admin=store.addUser({username:'admin',name:'Администратор',password:'testing-password-123'},null,true);store.importDirectory(directory,admin.id);return admin;};

test('creates plans from real IDs, persists after restart and records who created them',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'wb-portal-'));const file=join(folder,'db.sqlite');
  let store=openStore(file);
  try{
    const admin=setup(store);const saved=store.saveRequest(input(),admin);
    assert.equal(saved.route_id,61373);assert.equal(saved.driver_id,11);assert.equal(saved.status,'waiting');
    store.close();store=openStore(file);
    assert.equal(store.requests()[0].created_by_name,'Администратор');
    assert.equal(store.requests()[0].driver_label,'Водитель Один');
    assert.equal(store.activity()[0].action,'request_created');
  }finally{store.close();await rm(folder,{recursive:true,force:true});}
});

test('blocks driver, vehicle and trailer conflicts; pause releases resources and resume rechecks',()=>{
  const store=openStore(':memory:');try{
    const admin=setup(store),first=store.saveRequest(input(),admin);
    assert.throws(()=>store.saveRequest(input({vehicleId:22,trailerId:null}),admin),/Водитель/);
    assert.throws(()=>store.saveRequest(input({driverId:12,trailerId:null}),admin),/Автомобиль/);
    assert.throws(()=>store.saveRequest(input({driverId:12,vehicleId:22}),admin),/Прицеп/);
    const paused=store.changeStatus(first.id,'paused',first.version,admin);
    store.saveRequest(input({routeId:66091}),admin);
    assert.throws(()=>store.changeStatus(first.id,'waiting',paused.version,admin),/уже запланирован/);
    assert.equal(store.requests().length,2);
  }finally{store.close();}
});

test('allows multiple crews for same route/date and optional trailer; rejects stale concurrent edits',()=>{
  const store=openStore(':memory:');try{
    const admin=setup(store),first=store.saveRequest(input({trailerId:null}),admin);
    store.saveRequest(input({driverId:12,vehicleId:22,trailerId:null,priority:2}),admin);
    const edited=store.saveRequest({...input({note:'Изменено'}),version:first.version},admin,first.id);
    assert.equal(edited.version,2);
    assert.throws(()=>store.saveRequest({...input(),version:first.version},admin,first.id),/другим логистом/);
    assert.equal(store.requests().length,2);
  }finally{store.close();}
});

test('rejects invalid routes/dates/catalog IDs and imports atomically without erasing existing plans',()=>{
  const store=openStore(':memory:');try{
    const admin=setup(store);
    for(const fields of [{routeId:true},{routeId:0},{serviceDate:'2026-02-30'},{driverId:999},{vehicleId:31},{priority:100}])assert.throws(()=>store.saveRequest(input(fields),admin));
    store.saveRequest(input(),admin);
    assert.throws(()=>store.importDirectory({transport:{...directory.transport,drivers:[{id:11,name:'A'},{id:11,name:'B'}]}},admin.id),/повторный/);
    assert.equal(store.catalog().drivers.length,2);
    store.importDirectory({transport:{...directory.transport,drivers:[]}},admin.id);
    assert.equal(store.requests()[0].driver_label,'Водитель Один');
    assert.throws(()=>store.saveRequest(input(),admin),/справочнике/);
  }finally{store.close();}
});

test('imports valid WB records without names using explicit ID labels instead of losing the directory',()=>{
  const store=openStore(':memory:');try{
    const admin=setup(store);
    store.importDirectory({transport:{drivers:[{id:11,name:null}],vehicles:[{id:21,name:'',number_plate:''}],trailers:[]}},admin.id);
    assert.equal(store.catalog().drivers[0].label,'Водитель ID 11');
    assert.equal(store.catalog().vehicles[0].label,'Автомобиль ID 21');
    assert.equal(store.catalog().drivers[0].name,'');
  }finally{store.close();}
});

test('HTTP authentication, roles, same-origin writes, setup closure and full request lifecycle',async()=>{
  const store=openStore(':memory:');const server=createPortal({store,setupToken:'test-setup'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  let session='';
  const call=async(path,data,{cookie=session,extra={}}={})=>{
    const res=await fetch(origin+path,{method:data===undefined?'GET':'POST',headers:{...(data!==undefined?{'Content-Type':'application/json',Origin:origin}:{}),Cookie:cookie,...extra},...(data!==undefined?{body:JSON.stringify(data)}:{})});
    const value=(res.headers.get('content-type')||'').includes('json')?await res.json():await res.text();return {res,value};
  };
  try{
    assert.equal((await call('/api/requests')).res.status,401);
    assert.equal((await call('/api/bot/settings')).res.status,401);
    assert.equal((await call('/')).res.status,200);
    assert.equal((await call('/app.js')).res.status,200);const design=await call('/design.css');assert.equal(design.res.status,200);assert.match(design.res.headers.get('content-type'),/text\/css/);
    assert.equal((await call('/api/setup',{username:'admin',name:'Admin',password:'testing-password-123'})).res.status,403);
    const created=await call('/api/setup',{username:'admin',name:'Admin',password:'testing-password-123'},{extra:{'X-Setup-Token':'test-setup'}});
    assert.equal(created.res.status,201);session=created.res.headers.get('set-cookie').split(';')[0];
    assert.match(created.res.headers.get('set-cookie'),/HttpOnly/);
    assert.equal((await call('/api/bot/settings')).value.settings.intervalSeconds,60);
    const botDefaults=(await call('/api/bot/settings')).value.settings;
    const secret='test-secret-token-not-for-output';
    const savedBot=await call('/api/bot/settings',{...botDefaults,token:secret});
    assert.equal(savedBot.res.status,200);assert.equal(savedBot.value.settings.hasToken,true);
    assert.equal(JSON.stringify(savedBot.value).includes(secret),false);
    assert.equal(JSON.stringify((await call('/api/bot/status')).value).includes(secret),false);
    assert.equal(JSON.stringify((await call('/api/activity')).value).includes(secret),false);
    for(const asset of ['/vendor/tabulator/tabulator.min.js','/vendor/tabulator/tabulator.min.css']){const result=await fetch(origin+asset);assert.equal(result.status,200);}
    store.recordBotLog('poll_completed',{routes:[61373,65522,64197],total:300,targetRecords:9,candidates:0,newEvents:0});
    for(const endpoint of ['/api/bot/settings','/api/bot/status']){const result=await call(endpoint);assert.equal(result.value.serverVersion,'0.15.6');assert.equal(result.value.logs[0].kind,'poll_completed');assert.equal(result.value.logs[0].payload.total,300);assert.equal(JSON.stringify(result.value).includes(secret),false);}

    assert.equal((await call('/api/setup',{}, {extra:{'X-Setup-Token':'test-setup'}})).res.status,409);
    assert.equal((await call('/api/catalog/import',directory)).res.status,200);
    const req=await call('/api/requests',input());assert.equal(req.res.status,201);
    assert.equal((await call('/api/requests',input(),{extra:{Origin:'https://other.example'}})).res.status,403);
    assert.equal((await call('/api/users',{username:'logist',name:'Logist',password:'another-password-123'})).res.status,201);
    const logged=await call('/api/login',{username:'logist',password:'another-password-123'},{cookie:''});
    const logistCookie=logged.res.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/api/catalog/import',directory,{cookie:logistCookie})).res.status,404);
    assert.equal((await call('/api/bot/settings',undefined,{cookie:logistCookie})).res.status,403);
    assert.equal((await call('/api/bot/settings',{token:'must-not-be-saved'},{cookie:logistCookie})).res.status,403);
    assert.equal((await call('/api/bot/status',undefined,{cookie:logistCookie})).res.status,403);
    store.recordBotCandidates([{id:987,routeId:61373}],{response:{data:[{transport_request_id:987,extra:'retained'}]}});const snapshotId=store.getBotStatus(store.users()[0]).events[0].payload.snapshotId;
    assert.equal((await call('/api/bot/snapshots/'+snapshotId,undefined,{cookie:logistCookie})).res.status,403);
    const downloaded=await call('/api/bot/snapshots/'+snapshotId);assert.equal(downloaded.res.status,200);assert.equal(downloaded.value.response.data[0].extra,'retained');

    const publicStatus=await call('/api/bot/public-status',undefined,{cookie:logistCookie});assert.equal(publicStatus.res.status,200);assert.equal(JSON.stringify(publicStatus.value).includes(secret),false);
    assert.equal((await call('/api/catalog/sync',{}, {cookie:logistCookie})).res.status,403);
    assert.equal((await call('/api/requests',undefined,{cookie:logistCookie})).value.data.length,1);
    assert.equal((await call(`/api/requests/${req.value.data.id}/status`,{status:'archived',version:1})).res.status,200);
    const plan=req.value.data;store.recordAcceptanceResult({id:123456,routeId:plan.route_id,httpStatus:200,expected:{planId:plan.id,driverId:plan.driver_id,vehicleId:plan.vehicle_id},response:{data:{transport_request_id:123456,route_id:plan.route_id,supplier_id:12,driver_id:plan.driver_id,vehicle_id:plan.vehicle_id}}});
    const alerts=await call('/api/me/alerts');assert.equal(alerts.value.data.length,1);const alertId=alerts.value.data[0].id;
    assert.equal((await call('/api/me/alerts',undefined,{cookie:logistCookie})).value.data.length,0);
    assert.equal((await call('/api/me/alerts/'+alertId+'/ack',{}, {cookie:logistCookie})).res.status,404);
    assert.equal((await call('/api/me/alerts/'+alertId+'/ack',{})).res.status,200);
    assert.equal((await call('/api/me/alerts')).value.data.length,0);
    assert.equal((await call('/api/bot/test-alert',{}, {cookie:logistCookie})).res.status,403);
    const testAlert=await call('/api/bot/test-alert',{});assert.equal(testAlert.res.status,201);assert.equal((await call('/api/me/alerts')).value.data[0].payload.test,true);await call('/api/me/alerts/'+testAlert.value.id+'/ack',{});
    const ordinary=await call('/api/users',{username:'ordinary',name:'Ordinary',password:'another-password-123',role:'admin'});assert.equal(ordinary.res.status,201);
    const adminLogin=await call('/api/login',{username:'ordinary',password:'another-password-123'},{cookie:''});const adminCookie=adminLogin.res.headers.get('set-cookie').split(';')[0];
    const restricted=await call('/api/bot/status',undefined,{cookie:adminCookie});assert.equal(restricted.res.status,200);assert.deepEqual(restricted.value.logs,[]);assert.deepEqual(restricted.value.events,[]);
    assert.equal((await call('/api/bot/snapshots/'+snapshotId,undefined,{cookie:adminCookie})).res.status,403);
    assert.equal((await call('/api/users',{username:'elevated',name:'Elevated',password:'another-password-123',role:'super_admin'},{cookie:adminCookie})).res.status,403);
    assert.equal((await call('/api/users/'+created.value.user.id,{role:'logist'},{cookie:adminCookie})).res.status,403);
    for(const name of ['cat','frog','robot','bear','owl'])assert.equal((await call('/avatars/'+name+'.svg')).res.status,200);
    assert.equal((await call('/api/me/avatar',{preset:'owl'},{cookie:logistCookie})).res.status,200);
    assert.equal((await call('/api/session',undefined,{cookie:logistCookie})).value.user.avatar,'/avatars/owl.svg');
    assert.equal((await call('/api/me/avatar',{image:'data:image/svg+xml;base64,PHN2Zy8+'},{cookie:logistCookie})).res.status,400);
    assert.equal((await call('/api/me/avatar',{preset:'cat'},{cookie:''})).res.status,401);
    assert.equal((await call('/api/users',undefined,{cookie:logistCookie})).res.status,200);for(const endpoint of ['/api/session','/api/catalog','/api/requests','/api/users','/api/bot/public-status'])assert.equal((await call(endpoint,undefined,{cookie:logistCookie})).res.status,200);
    assert.equal((await call('/api/users/'+ordinary.value.data.id,{role:'logist'})).res.status,200);
    assert.equal((await call('/api/bot/status',undefined,{cookie:adminCookie})).res.status,403);
    await call('/api/logout',{});
    assert.equal((await call('/api/requests')).res.status,401);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});

