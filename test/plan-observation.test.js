import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,businessDate} from '../src/store.js';
import {BotWorker} from '../src/bot.js';
import {dashboard} from '../src/dashboard.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
function setup(){const store=openStore(':memory:'),admin=store.addUser({username:'root',name:'Root',password:'testing-password-123'},null,true),logist=store.addUser({username:'logist',name:'Logist',password:'testing-password-123',role:'logist'},admin);store.importDirectory({transport:{drivers:[{id:1,name:'Driver'},{id:3,name:'Other'}],vehicles:[{id:2,name:'Truck'},{id:4,name:'Other truck'}],trailers:[]}},admin.id);return {store,admin,logist};}
const input=(extra={})=>({routeId:61373,serviceDate:businessDate(),driverId:1,vehicleId:2,priority:1,...extra});
const card={transport_request_id:100,route_id:61373,route_name:'Test route',supplier_id:null,car_dt:'2026-11-23T13:00:00+03:00',request_status:'created',is_closed:false};
function enable(store,admin,supplierId=10){store.saveBotSettings({...store.getBotSettings(admin),enabled:true,token:'test-token-value',supplierId,acceptanceEnabled:false},admin);}
test('monitor-only plan notifies owner and followers once, never sends PUT and finishes after the first discovery',async()=>{
 const {store,admin,logist}=setup();try{
 const plan=store.saveRequest(input({observeOnly:true}),admin);store.watchRequest(plan.id,true,logist);enable(store,admin,0);let now=new Date(),puts=0;
 const worker=new BotWorker(store,{clock:()=>now,fetchImpl:async(url,options)=>{if(options.method==='PUT')puts++;return Response.json({data:url.endsWith('TO_DELIVERY')?[card]:card});}});
 await worker.tick();assert.equal(puts,0);const owner=store.userAlerts(admin)[0],follower=store.userAlerts(logist)[0];assert.equal(owner.payload.observed,true);assert.equal(owner.payload.id,100);assert.equal(owner.payload.planId,plan.id);assert.equal(follower.payload.watching,true);assert.match(owner.payload.message,/не отправлялся/);assert.equal(store.requests()[0].status,'found');assert.equal(store.pendingAcceptances().length,0);
 store.acknowledgeAlert(owner.id,admin);now=new Date(now.getTime()+61000);await worker.tick();assert.equal(store.userAlerts(admin).length,0);assert.equal(store.userAlerts(logist).length,1);assert.equal(puts,0);assert.equal(store.getBotStatus(admin).outcomes.length,0);
 }finally{store.close();}
});
test('default live plans accept even if an obsolete global false is submitted; observation never reserves crew or enters claim',async()=>{
 const {store,admin,logist}=setup();try{
 const observer=store.saveRequest(input({observeOnly:true,priority:1}),logist),live=store.saveRequest(input({priority:2}),admin);assert.equal(live.observe_only,0);enable(store,admin);assert.equal(store.botConfig().acceptanceEnabled,true);assert.equal(store.claimAcceptance(101,observer,Date.now()),null);let puts=0;
 const worker=new BotWorker(store,{fetchImpl:async(url,options)=>{if(options.method==='PUT'){puts++;assert.equal(JSON.parse(options.body).driver,1);return Response.json({data:{...card,supplier_id:10,driver_id:1,vehicle_id:2}});}return Response.json({data:url.endsWith('TO_DELIVERY')?[card]:card});}});
 await worker.tick();assert.equal(puts,1);assert.equal(store.requests().find(p=>p.id===live.id).accepted_wb_id,100);assert.equal(store.requests().find(p=>p.id===observer.id).status,'found');assert.equal(store.userAlerts(logist)[0].payload.observed,true);assert.equal(Boolean(store.userAlerts(admin)[0].payload.observed),false);
 }finally{store.close();}
});
test('plan mode is validated, preserved on omitted update, cannot race a pending PUT, and rejects stale observation claims',()=>{
 const {store,admin}=setup();try{
 let plan=store.saveRequest(input(),admin);for(const observeOnly of ['true',1,'on'])assert.throws(()=>store.saveRequest(input({observeOnly,version:plan.version}),admin,plan.id));
 const stale=plan;plan=store.saveRequest(input({observeOnly:true,version:plan.version}),admin,plan.id);assert.equal(plan.observe_only,1);plan=store.saveRequest(input({version:plan.version}),admin,plan.id);assert.equal(plan.observe_only,1);enable(store,admin);assert.equal(store.claimAcceptance(100,stale,Date.now()),null);
 plan=store.saveRequest(input({observeOnly:false,version:plan.version}),admin,plan.id);assert.ok(store.claimAcceptance(100,plan,Date.now()));assert.throws(()=>store.saveRequest(input({observeOnly:true,version:plan.version}),admin,plan.id),/ещё проверяется/);
 }finally{store.close();}
});
test('future or paused observation plans never create discovery notifications',()=>{
 const {store,admin}=setup();try{const plan=store.saveRequest(input({observeOnly:true}),admin);assert.equal(store.notifyObservedCandidate({id:100,routeId:61373},'2000-01-01'),0);store.changeStatus(plan.id,'paused',plan.version,admin);assert.equal(store.notifyObservedCandidate({id:100,routeId:61373},businessDate()),0);}finally{store.close();}
});
test('legacy preview migration stops bot for review and keeps plans and tokens unchanged',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'portal-mode-')),file=join(dir,'db.sqlite');let store=openStore(file);
 try{const admin=store.addUser({username:'root',name:'Root',password:'testing-password-123'},null,true);store.saveBotSettings({...store.getBotSettings(admin),token:'private-test-token'},admin);const config=store.botConfig();delete config.token;store.db.prepare("UPDATE settings SET value=? WHERE key='bot_config'").run(JSON.stringify({...config,enabled:true,acceptanceEnabled:false}));store.db.prepare("DELETE FROM settings WHERE key='per_plan_acceptance_v1'").run();store.close();store=openStore(file);assert.equal(store.botConfig().enabled,false);assert.equal(store.botConfig().acceptanceEnabled,true);assert.equal(store.botConfig().token,'private-test-token');assert.match(store.getBotStatus(admin).runtime.warning,/перенесён/);const revision=store.botConfig().revision;store.close();store=openStore(file);assert.equal(store.botConfig().revision,revision);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('stopped dashboard warns even with no ready plans, and retains an actual stop error',()=>{
 const {store,admin,logist}=setup();try{for(const user of [admin,logist])assert.ok(dashboard(store,user).alerts.some(a=>a.title==='Бот остановлен'));store.setBotRuntime({state:'auth_error',error:'Token rejected'});assert.ok(dashboard(store,admin).alerts.some(a=>a.tone==='error'&&a.text==='Token rejected'));}finally{store.close();}
});

test('observation alert survives a later card failure in the same poll',async()=>{
 const {store,admin}=setup();try{
 store.saveRequest(input({observeOnly:true}),admin);store.saveRequest(input({observeOnly:true,routeId:65522}),admin);enable(store,admin,0);let puts=0;
 const worker=new BotWorker(store,{fetchImpl:async(url,options)=>{
  if(options.method==='PUT')puts++;
  if(url.endsWith('TO_DELIVERY'))return Response.json({data:[card,{...card,route_id:65522,transport_request_id:101}]});
  if(url.endsWith('/101'))return Response.json({message:'Unavailable'},{status:503});
  return Response.json({data:card});
 }});
 await worker.tick();assert.equal(puts,0);assert.equal(store.userAlerts(admin).length,1);assert.equal(store.userAlerts(admin)[0].payload.id,100);
 assert.ok(store.botHistoryPage('logs',{q:'poll_failed'},admin).total);
 }finally{store.close();}
});


test('observation stops after one of several available WB requests, survives acknowledgement and restart',async()=>{
 const {store,admin}=setup();try{
 const plan=store.saveRequest(input({observeOnly:true}),admin);enable(store,admin,0);let calls=0;
 const worker=new BotWorker(store,{fetchImpl:async url=>{calls++;return Response.json({data:url.endsWith('TO_DELIVERY')?[card,{...card,transport_request_id:101}]:{...card,transport_request_id:Number(url.split('/').at(-1))}});}});
 await worker.tick();const found=store.requests()[0];assert.equal(found.status,'found');assert.equal(found.found_wb_id,100);assert.equal(store.userAlerts(admin).length,1);assert.equal(calls,2);assert.equal(store.getBotStatus(admin).events.length,1);
 assert.equal(store.notifyObservedCandidate({...card,id:102,routeId:61373},businessDate()),0);
 store.acknowledgeAlert(store.userAlerts(admin)[0].id,admin);const before=calls;
 await new BotWorker(store,{fetchImpl:async()=>{calls++;throw new Error('must not poll');}}).tick();assert.equal(calls,before);assert.equal(store.userAlerts(admin).length,0);
 assert.throws(()=>store.saveRequest(input({version:found.version}),admin,plan.id),/только перенести в архив/);
 assert.throws(()=>store.changeStatus(plan.id,'waiting',found.version,admin),/только перенести в архив/);
 assert.equal(dashboard(store,admin).stats.active,0);assert.equal(dashboard(store,admin).upcoming.length,0);
 assert.equal(store.changeStatus(plan.id,'archived',found.version,admin).status,'archived');
 }finally{store.close();}
});
