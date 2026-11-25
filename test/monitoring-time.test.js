import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,businessDate} from '../src/store.js';
import {BotWorker} from '../src/bot.js';
import {monitoringDue} from '../src/monitoring-time.js';
import {seedPreviewDemo} from '../src/server.js';
import {dashboard} from '../src/dashboard.js';

test('monitoring starts at the configured local minute, old plans default to midnight',async()=>{
 const store=openStore(':memory:');try{
  const root=store.addUser({username:'root',name:'Root',password:'test-password-123'},null,true),today=businessDate();
  store.importDirectory({transport:{drivers:[{id:1,name:'Driver'}],vehicles:[{id:2,name:'Truck'}],trailers:[]}},root.id);
  const input={routeId:65522,serviceDate:today,serviceTime:'10:00',driverId:1,vehicleId:2,observeOnly:true};
  const plan=store.saveRequest(input,root);assert.equal(plan.service_time,'10:00');
  for(const bad of ['24:00','9:00','12:60','',true])assert.throws(()=>store.saveRequest({...input,serviceTime:bad},root));
  let now=new Date(today+'T09:59:59+05:00'),calls=0;
  assert.equal(monitoringDue(plan,now),false);assert.equal(monitoringDue({...plan,service_time:'00:00'},now),true);
  assert.equal(monitoringDue({...plan,service_time:undefined},now),true);
  const settings=store.getBotSettings(root),token='h.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+86400})).toString('base64url')+'.s';
  store.saveBotSettings({...settings,enabled:true,token,supplierId:10095401},root);
  const worker=new BotWorker(store,{clock:()=>now,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({data:[]}),{headers:{'Content-Type':'application/json'}});}});
  await worker.tick();assert.equal(calls,0,'not a single WB request before the start time');
  assert.equal(store.notifyObservedCandidate({id:123,routeId:65522},today,now),0);
  now=new Date(today+'T10:00:00+05:00');assert.equal(monitoringDue(plan,now),true);await worker.tick();assert.equal(calls,1);
  const saved=store.saveRequest({...input,serviceTime:undefined,version:plan.version},root,plan.id);assert.equal(saved.service_time,'10:00');
  assert.equal(store.notifyObservedCandidate({id:123,routeId:65522},today,now),1);

 }finally{store.close();}
});
test('processed subscribed plans are excluded from dashboard watched and upcoming lists',()=>{
 const store=openStore(':memory:');try{
  seedPreviewDemo(store);const root=store.users().find(u=>u.role==='super_admin'),plan=store.requests().find(p=>p.created_by!==root.id&&p.status==='waiting');
  store.watchRequest(plan.id,true,root);
  store.db.prepare("INSERT INTO acceptance_attempts(id,plan_id,driver_id,vehicle_id,state,tries,updated_at,retry_at,expected) VALUES(?,?,?,?, 'success',1,?,0,'{}')").run(99123,plan.id,plan.driver_id,plan.vehicle_id,Date.now());
  const data=dashboard(store,root);assert.ok(!data.watched.some(p=>p.id===plan.id));assert.ok(!data.upcoming.some(p=>p.id===plan.id));assert.equal(data.stats.accepted,1);
 }finally{store.close();}
});
test('test alerts can target a colleague with no plans and reject blocked recipients',()=>{
 const store=openStore(':memory:');try{
  seedPreviewDemo(store);const root=store.users().find(u=>u.role==='super_admin'),person=store.addUser({username:'no.plans',name:'New colleague',password:'test-password-123',role:'logist'},root);
  assert.ok(!store.requests().some(p=>p.created_by===person.id));
  const result=store.createTestAlert(null,root,person.id);assert.equal(result.recipient,person.name);assert.equal(store.userAlerts(person).length,1);assert.equal(store.userAlerts(root).length,0);
  store.db.prepare('UPDATE users SET blocked=1 WHERE id=?').run(person.id);assert.throws(()=>store.createTestAlert(null,root,person.id),e=>e.status===403);
  assert.throws(()=>store.createTestAlert(null,root,999999),e=>e.status===404);
 }finally{store.close();}
});
