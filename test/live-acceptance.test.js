import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,businessDate} from '../src/store.js';
import {BotWorker} from '../src/bot.js';
function setup(file=':memory:'){
 const store=openStore(file),admin=store.userCount()?store.users()[0]:store.addUser({username:'root',name:'Root',password:'password-12345'},null,true);
 if(!store.requests().length){store.importDirectory({transport:{drivers:[{id:1,name:'Driver'}],vehicles:[{id:2,name:'Vehicle'}],trailers:[{id:3,name:'Trailer'}]}},admin.id);store.saveRequest({routeId:61373,serviceDate:businessDate(),driverId:1,vehicleId:2,trailerId:null,priority:1},admin);}
 store.saveBotSettings({...store.getBotSettings(admin),enabled:true,acceptanceEnabled:true,supplierId:10,token:'test-token-value',requestsPerMinute:20,intervalSeconds:3},admin);return {store,admin};
}
const row=id=>({transport_request_id:id,route_id:61373,supplier_id:null,car_dt:businessDate()+'T23:00:00+03:00',request_status:'created',is_closed:false});
const assigned=id=>({...row(id),supplier_id:10,driver_id:1,vehicle_id:2,request_status:null});
test('live success sends captured payload once, pauses plan and notifies owner; second card cannot reuse crew',async()=>{
 const {store,admin}=setup();let puts=0;const worker=new BotWorker(store,{fetchImpl:async(url,options)=>{assert.equal(options.redirect,'manual');if(options.method==='PUT'){puts++;assert.deepEqual(JSON.parse(options.body),{vehicle:2,driver:1,freelancerID:null,accept_round_trip:false});return Response.json({data:assigned(Number(url.split('/').at(-2)))});}return Response.json({data:url.endsWith('TO_DELIVERY')?[row(100),row(101)]:row(Number(url.split('/').pop()))});}});
 try{await worker.tick();assert.equal(puts,1);assert.equal(store.requests()[0].status,'paused');assert.equal(store.requests()[0].accepted_wb_id,100);assert.equal(store.userAlerts(admin).length,1);assert.equal(store.getBotStatus(admin).outcomes[0].kind,'acceptance_success');assert.ok(Number.isFinite(Date.parse(store.userAlerts(admin)[0].payload.acceptedAt)));assert.equal(store.userAlerts(admin)[0].payload.acceptedAt,store.userAlerts(admin)[0].created_at);assert.deepEqual(store.getBotStatus(admin).logs.find(l=>l.kind==='poll_completed').payload.routeSummary,[{routeId:61373,records:[{id:100,supplierId:null,status:'created'},{id:101,supplierId:null,status:'created'}]}]);await worker.tick();assert.equal(puts,1);
 const processed=store.requests()[0],before=store.requests().find(r=>r.id===processed.id);
 assert.throws(()=>store.saveRequest({routeId:65522,serviceDate:processed.service_date,driverId:1,vehicleId:2,priority:1,version:processed.version},admin,processed.id),/Обработанную заявку нельзя редактировать/);
 assert.deepEqual(store.requests().find(r=>r.id===processed.id),before);
 assert.throws(()=>store.changeStatus(processed.id,'waiting',processed.version,admin),/только перенести в архив/);
 store.changeStatus(processed.id,'archived',processed.version,admin);assert.equal(store.requests().find(r=>r.id===processed.id).status,'archived');
 }finally{store.close();}
});
test('definitive conflict retries after cooldown without requiring a new detection, at most three PUTs',async()=>{
 const {store,admin}=setup();let puts=0,now=new Date();const worker=new BotWorker(store,{clock:()=>now,fetchImpl:async(url,options)=>{if(options.method==='PUT'){puts++;return Response.json({success:false,error:{message:'Выбранный маршрут нельзя взять в работу.'}},{status:409});}return Response.json({data:url.endsWith('TO_DELIVERY')?[row(100)]:row(100)});}});
 try{await worker.tick();assert.equal(puts,1);now=new Date(now.getTime()+4000);await worker.tick();assert.equal(puts,1);for(let i=0;i<4;i++){now=new Date(now.getTime()+61000);await worker.tick();}assert.equal(puts,3);assert.equal(store.userAlerts(admin).length,1);assert.equal(store.userAlerts(admin)[0].payload.acceptanceError,true);assert.equal(store.requests()[0].status,'waiting');assert.match(store.getBotStatus(admin).outcomes[0].payload.message,/маршрут/);}finally{store.close();}
});
test('lost response is reconciled after restart without a second PUT',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wb-live-')),file=join(dir,'portal.sqlite');let {store,admin}=setup(file);let puts=0;
 try{let worker=new BotWorker(store,{fetchImpl:async(url,options)=>{if(options.method==='PUT'){puts++;throw new Error('timeout');}return Response.json({data:url.endsWith('TO_DELIVERY')?[row(100)]:row(100)});}});await worker.tick();assert.equal(store.pendingAcceptances()[0].state,'uncertain');store.close();({store,admin}=setup(file));
 worker=new BotWorker(store,{fetchImpl:async(url,options)=>{assert.equal(options.method,'GET');return Response.json({data:url.endsWith('TO_DELIVERY')?[]:assigned(100)});}});await worker.tick();assert.equal(puts,1);assert.equal(store.pendingAcceptances().length,0);assert.equal(store.requests()[0].status,'paused');assert.equal(store.userAlerts(admin).length,2);assert.equal(store.userAlerts(admin)[0].payload.uncertain,true);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('wrong supplier cannot produce green success and uncertain PUT is not blindly repeated',async()=>{
 const {store,admin}=setup();let puts=0,now=new Date();const worker=new BotWorker(store,{clock:()=>now,fetchImpl:async(url,options)=>{if(options.method==='PUT'){puts++;return Response.json({data:{...assigned(100),supplier_id:999}});}return Response.json({data:url.endsWith('TO_DELIVERY')?[row(100)]:row(100)});}});
 try{await worker.tick();assert.equal(store.userAlerts(admin).length,1);assert.equal(store.userAlerts(admin)[0].payload.acceptanceError,true);assert.equal(store.getBotStatus(admin).outcomes[0].kind,'acceptance_error');now=new Date(now.getTime()+61000);await worker.tick();assert.equal(puts,1);}finally{store.close();}
});
test('401 from PUT stops the bot; trailers are never silently omitted',async()=>{
 const {store,admin}=setup();let puts=0;const worker=new BotWorker(store,{fetchImpl:async(url,options)=>{if(options.method==='PUT'){puts++;return Response.json({error:{message:'Unauthorized'}},{status:401});}return Response.json({data:url.endsWith('TO_DELIVERY')?[row(100)]:row(100)});}});
 try{let plan=store.requests()[0];store.saveRequest({routeId:plan.route_id,serviceDate:plan.service_date,driverId:1,vehicleId:2,trailerId:3,priority:1,version:plan.version},admin,plan.id);await worker.tick();assert.equal(puts,0);plan=store.requests()[0];store.saveRequest({routeId:plan.route_id,serviceDate:plan.service_date,driverId:1,vehicleId:2,trailerId:null,priority:1,version:plan.version},admin,plan.id);worker.nextAt=0;worker.lastAttempt=0;await worker.tick();assert.equal(puts,1);assert.equal(store.botConfig().enabled,false);}finally{store.close();}
});

test('persistent claim protects plan and crew from concurrent attempts and stale edits',()=>{
 const {store,admin}=setup();try{const plan=store.requests()[0],now=Date.now();assert.ok(store.claimAcceptance(100,plan,now));assert.equal(store.claimAcceptance(101,plan,now),null);assert.equal(store.claimAcceptance(100,plan,now),null);assert.throws(()=>store.getAcceptanceAttempt(100,{role:'admin'}));assert.equal(store.getAcceptanceAttempt(100,admin).state,'pending');}finally{store.close();}
});
test('429 on PUT respects retry delay and prevents other acceptance in the same poll',async()=>{
 const {store}=setup();let puts=0,now=new Date();const worker=new BotWorker(store,{clock:()=>now,fetchImpl:async(url,options)=>{if(options.method==='PUT'){puts++;return Response.json({error:{message:'Rate limit'}},{status:429,headers:{'Retry-After':'180'}});}return Response.json({data:url.endsWith('TO_DELIVERY')?[row(100),row(101)]:row(Number(url.split('/').pop()))});}});
 try{await worker.tick();assert.equal(puts,1);assert.ok(worker.nextAt>=now.getTime()+180000);now=new Date(now.getTime()+61000);await worker.tick();assert.equal(puts,1);}finally{store.close();}
});

test('admin may delete discovery for replay without clearing pending acceptance protection',()=>{
 const {store,admin}=setup();try{store.recordBotCandidates([{id:100,routeId:61373,planId:store.requests()[0].id}]);const event=store.getBotStatus(admin).events[0];assert.throws(()=>store.deleteBotEvent(event.id,{id:admin.id,role:'admin'}));assert.throws(()=>store.deleteBotEvent(event.id,{id:admin.id,role:'logist'}));store.claimAcceptance(100,store.requests()[0],Date.now());store.deleteBotEvent(event.id,admin);assert.equal(store.getBotStatus(admin).events.length,0);assert.equal(store.pendingAcceptances().length,1);assert.equal(store.recordBotCandidates([{id:100,routeId:61373,planId:store.requests()[0].id}]),1);assert.equal(store.claimAcceptance(100,store.requests()[0],Date.now()),null);}finally{store.close();}
});

test('success result, owner alert and plan pause roll back together on a storage failure',()=>{
 const {store,admin}=setup();try{const plan=store.requests()[0],expected=store.claimAcceptance(777,plan,Date.now());store.db.exec("CREATE TRIGGER reject_pause BEFORE UPDATE OF status ON requests BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;");assert.throws(()=>store.finishAcceptance(777,expected,200,{data:assigned(777)},'success',Date.now()),/test storage failure/);assert.equal(store.requests()[0].status,'waiting');assert.equal(store.requests()[0].accepted_wb_id,null);assert.equal(store.getBotStatus(admin).outcomes.length,0);assert.equal(store.userAlerts(admin).length,0);assert.equal(store.pendingAcceptances().length,1);}finally{store.close();}
});


test('429 stays uncertain after cooldown even when GET reports unassigned, then confirms assignment without another PUT',async()=>{
 const {store,admin}=setup();let puts=0,gets=0,now=new Date(),accepted=false;
 const worker=new BotWorker(store,{clock:()=>now,fetchImpl:async(url,options)=>{
  if(options.method==='PUT'){puts++;return Response.json({error:{message:'Rate limit'}},{status:429,headers:{'Retry-After':'180'}});}
  if(!url.endsWith('TO_DELIVERY'))gets++;
  return Response.json({data:url.endsWith('TO_DELIVERY')?[row(100)]:(accepted?assigned(100):row(100))});
 }});
 try{
 await worker.tick();assert.equal(store.getAcceptanceAttempt(100,admin).state,'uncertain');assert.equal(puts,1);
 assert.equal(store.claimAcceptance(101,store.requests()[0],now.getTime()+200000),null,'unknown result reserves crew');
 const before=gets;now=new Date(now.getTime()+61000);await worker.tick();assert.equal(gets,before);
 now=new Date(now.getTime()+180000);await worker.tick();assert.equal(puts,1);assert.equal(store.getAcceptanceAttempt(100,admin).state,'uncertain');
 accepted=true;now=new Date(now.getTime()+61000);await worker.tick();assert.equal(puts,1);assert.equal(store.getAcceptanceAttempt(100,admin).state,'success');assert.equal(store.userAlerts(admin).length,2);
 }finally{store.close();}
});

test('legacy failed 429 is migrated on restart and failed verification never unlocks a second PUT',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wb-429-')),file=join(dir,'portal.sqlite');let {store,admin}=setup(file);let now=new Date(),puts=0;
 try{
 const plan=store.requests()[0],expected=store.claimAcceptance(100,plan,now.getTime());
 store.finishAcceptance(100,expected,429,{error:{message:'Rate limit'}},'failed',now.getTime(),180000);
 assert.equal(store.getAcceptanceAttempt(100,admin).state,'uncertain','store must prevent callers making 429 retryable');
 store.db.prepare("UPDATE acceptance_attempts SET state='failed' WHERE id=100").run();store.close();({store,admin}=setup(file));
 assert.equal(store.getAcceptanceAttempt(100,admin).state,'uncertain');now=new Date(now.getTime()+181000);
 const worker=new BotWorker(store,{clock:()=>now,fetchImpl:async(url,options)=>{if(options.method==='PUT')puts++;return Response.json({error:{message:'Unavailable'}},{status:503});}});
 await worker.tick();assert.equal(puts,0);assert.equal(store.getAcceptanceAttempt(100,admin).state,'uncertain');assert.equal(store.claimAcceptance(100,store.requests()[0],now.getTime()),null);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});


test('acceptance failure alerts author and followers once; acknowledgement does not suppress later success',()=>{
 const {store,admin}=setup();try{
 const watcher=store.addUser({username:'watcher',name:'Watcher',role:'logist',password:'password-12345'},admin),other=store.addUser({username:'other',name:'Other',role:'logist',password:'password-12345'},admin),plan=store.requests()[0];store.watchRequest(plan.id,true,watcher);
 const expected=store.claimAcceptance(100,plan,Date.now());
 store.finishAcceptance(100,expected,429,{error:{message:'Результат неизвестен'}},'uncertain',Date.now());
 for(const user of [admin,watcher]){const alerts=store.userAlerts(user);assert.equal(alerts.length,1);assert.equal(alerts[0].payload.acceptanceError,true);assert.equal(alerts[0].payload.uncertain,true);assert.equal(alerts[0].payload.httpStatus,429);assert.equal(alerts[0].payload.id,100);assert.equal(alerts[0].payload.planId,plan.id);}
 assert.equal(store.userAlerts(other).length,0);assert.equal(store.userAlerts(watcher)[0].payload.watching,true);
 const error=store.userAlerts(admin)[0];store.acknowledgeAlert(error.id,admin);
 store.finishAcceptance(100,expected,503,{error:{message:'Unavailable'}},'uncertain',Date.now());assert.equal(store.userAlerts(admin).length,0);assert.equal(store.userAlerts(watcher).length,1);
 store.finishAcceptance(100,expected,200,{data:assigned(100)},'success',Date.now());assert.equal(store.userAlerts(admin).length,1);assert.equal(Boolean(store.userAlerts(admin)[0].payload.acceptanceError),false);assert.equal(store.userAlerts(watcher).length,2);
 }finally{store.close();}
});
