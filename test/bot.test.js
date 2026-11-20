import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, businessDate } from '../src/store.js';
import { BotWorker, withinSchedule, previewCurl } from '../src/bot.js';

const testToken=`header.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+864000})).toString('base64url')}.test-signature`;
function init(file=':memory:'){
  const store=openStore(file);
  const admin=store.userCount()?store.users()[0]:store.addUser({username:'admin',name:'Admin',password:'password-test-123'},null,true);
  return{store,admin};
}
function config(store,admin,extra={}){
  const current=store.getBotSettings(admin);
  return store.saveBotSettings({...current,token:testToken,...extra},admin);
}
function addPlan(store,admin){
  store.importDirectory({transport:{drivers:[{id:1,name:'Driver'}],vehicles:[{id:2,name:'Vehicle'}],trailers:[]}},admin.id);
  store.saveRequest({routeId:61373,serviceDate:businessDate(),driverId:1,vehicleId:2,trailerId:null,priority:1},admin);
}
test('default settings, validation and admin-only access protect bot configuration',()=>{
  const{store,admin}=init();try{
    const initial=store.getBotSettings(admin);assert.equal(initial.intervalSeconds,60);assert.equal(initial.enabled,false);assert.equal(initial.hasToken,false);
    assert.throws(()=>store.getBotSettings({role:'logist'}),/администратору/);
    for(const extra of [{intervalSeconds:2},{intervalSeconds:1.5},{days:[1,1]},{scheduleEnabled:true,days:[]},{scheduleEnabled:true,startTime:'08:00',endTime:'08:00'}])assert.throws(()=>config(store,admin,extra));
    assert.throws(()=>store.saveBotSettings({...initial,enabled:true},admin),/токен/);
    const saved=config(store,admin,{enabled:true,intervalSeconds:3});assert.equal(saved.intervalSeconds,3);assert.equal(saved.hasToken,true);assert.equal(saved.revision,1);
    assert.equal(JSON.stringify(saved).includes(testToken),false);assert.equal(JSON.stringify(store.activity()).includes(testToken),false);
    assert.throws(()=>store.saveBotSettings({...initial,token:testToken},admin),/другим администратором/);
  }finally{store.close();}
});
test('token is encrypted at rest, survives restart, blank preserves it and explicit removal clears it',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'wb-bot-'));const file=join(folder,'portal.sqlite');let{store,admin}=init(file);
  try{
    config(store,admin);const raw=store.db.prepare("SELECT value FROM settings WHERE key='bot_token'").get().value;assert.equal(raw.includes(testToken),false);
    assert.equal((await readFile(join(folder,'bot-secret.key'))).length,32);
    store.close();({store,admin}=init(file));assert.equal(store.botConfig().token,testToken);
    config(store,admin,{token:''});assert.equal(store.botConfig().token,testToken);
    config(store,admin,{token:'',clearToken:true,enabled:false});assert.equal(store.getBotSettings(admin).hasToken,false);
  }finally{store.close();await rm(folder,{recursive:true,force:true});}
});
test('weekly schedule uses local timezone, start inclusive/end exclusive, and previous weekday overnight',()=>{
  const c={scheduleEnabled:true,timeZone:'Asia/Yekaterinburg',days:[5],startTime:'22:00',endTime:'06:00'};
  assert.equal(withinSchedule(c,new Date('2026-11-20T17:00:00Z')),true);
  assert.equal(withinSchedule(c,new Date('2026-11-21T00:59:00Z')),true);
  assert.equal(withinSchedule(c,new Date('2026-11-21T01:00:00Z')),false);
  assert.equal(withinSchedule(c,new Date('2026-11-21T18:00:00Z')),false);
  const day={...c,startTime:'08:00',endTime:'20:00'};
  assert.equal(withinSchedule(day,new Date('2026-11-20T03:00:00Z')),true);
  assert.equal(withinSchedule(day,new Date('2026-11-20T15:00:00Z')),false);
  assert.equal(withinSchedule({...c,scheduleEnabled:false},new Date('2026-11-21T18:00:00Z')),true);
});
test('worker is read-only, scopes candidates by planned route AND local date, and deduplicates observations',async()=>{
  const{store,admin}=init();let now=new Date();const calls=[];const date=businessDate();
  const base={transport_request_id:100,route_id:61373,supplier_id:null,car_dt:`${date}T12:00:00+05:00`};
  const fetchImpl=async(url,options)=>{calls.push(url);assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,`Bearer ${testToken}`);assert.equal(options.redirect,'manual');
    if(url.endsWith('TO_DELIVERY'))return Response.json({data:[base,{...base,transport_request_id:101,route_id:66091},{...base,transport_request_id:102,car_dt:'2020-01-01T12:00:00+05:00'}]});
    return Response.json({data:{...base,request_status:'created',is_closed:false,cubature_value:90,price_per_km:100}});
  };
  try{
    addPlan(store,admin);const worker=new BotWorker(store,{fetchImpl,clock:()=>now});
    await worker.tick();assert.equal(calls.length,0);
    config(store,admin,{enabled:true});await worker.tick();assert.equal(calls.length,2);assert.equal(store.getBotStatus(admin).events.length,1);assert.equal(store.getBotStatus(admin).events[0].payload.id,100);
    const snapshot=store.getBotStatus(admin);assert.ok(snapshot.logs.some(e=>e.kind==='request_started'));assert.ok(snapshot.logs.some(e=>e.payload.httpStatus===200));
    assert.ok(snapshot.events[0].payload.curl.includes('"vehicle":2,"driver":1'));assert.ok(snapshot.events[0].payload.curl.includes('$env:WB_TOKEN'));assert.equal(JSON.stringify(snapshot).includes(testToken),false);
    await worker.tick();assert.equal(calls.length,2);
    now=new Date(now.getTime()+61000);await worker.tick();assert.equal(calls.length,4);assert.equal(store.getBotStatus(admin).events.length,1);
    config(store,admin,{enabled:false,token:''});worker.changed();await worker.tick();assert.equal(calls.length,4);
  }finally{store.close();}
});
test('no plans and outside schedule make no requests; denied token disables the bot',async()=>{
  const{store,admin}=init();let calls=0;const worker=new BotWorker(store,{fetchImpl:async()=>{calls++;return new Response('',{status:401});}});
  try{
    config(store,admin,{enabled:true});await worker.tick();assert.equal(calls,0);assert.equal(store.getBotStatus(admin).runtime.state,'no_plans');
    addPlan(store,admin);config(store,admin,{enabled:true,scheduleEnabled:true,days:[1],startTime:'01:00',endTime:'02:00'});
    assert.equal(store.getBotSettings(admin).scheduleEnabled,false);
    config(store,admin,{enabled:true,scheduleEnabled:false});await worker.tick();assert.equal(calls,1);assert.equal(store.getBotSettings(admin).enabled,false);
  }finally{store.close();}
});
test('disabling during an in-flight request aborts it and prevents late candidate records',async()=>{
  const{store,admin}=init();let finish;let abortedSignal;
  try{
    addPlan(store,admin);config(store,admin,{enabled:true});
    const worker=new BotWorker(store,{fetchImpl:(url,options)=>{abortedSignal=options.signal;return new Promise(resolve=>{finish=resolve;});}});
    const pending=worker.tick();await new Promise(resolve=>setImmediate(resolve));
    config(store,admin,{enabled:false});worker.changed();await worker.tick();assert.equal(abortedSignal.aborted,true);
    finish(Response.json({data:[]}));await pending;assert.equal(store.getBotStatus(admin).events.length,0);
  }finally{store.close();}
});

test('rate limits respect Retry-After and a malformed snapshot cannot erase recorded candidates',async()=>{
  const{store,admin}=init();let now=new Date();let calls=0,mode='good';const date=businessDate();
  const row={transport_request_id:100,route_id:61373,car_dt:`${date}T12:00:00+05:00`,supplier_id:null};
  const worker=new BotWorker(store,{clock:()=>now,fetchImpl:async url=>{
    calls++;
    if(mode==='rate')return new Response('',{status:429,headers:{'Retry-After':'180'}});
    if(mode==='broken')return Response.json({error:'unexpected'});
    return Response.json({data:url.endsWith('TO_DELIVERY')?[row]:{...row,request_status:'created',is_closed:false}});
  }});
  try{
    addPlan(store,admin);config(store,admin,{enabled:true});await worker.tick();
    assert.equal(store.getBotStatus(admin).events.length,1);
    now=new Date(now.getTime()+61000);mode='broken';await worker.tick();
    assert.equal(store.db.prepare('SELECT active FROM bot_observations WHERE id=100').get().active,1);
    now=new Date(now.getTime()+61000);mode='rate';await worker.tick();const before=calls;
    assert.ok(Date.parse(store.getBotStatus(admin).runtime.nextPollAt)>=now.getTime()+180000);
    now=new Date(now.getTime()+61000);await worker.tick();assert.equal(calls,before);
    assert.equal(store.getBotSettings(admin).enabled,true);
  }finally{store.close();}
});



test('preview uses validated IDs, never embeds credentials and refuses unconfirmed trailer payload',()=>{
  assert.ok(previewCurl(123,{driver_id:4,vehicle_id:5,trailer_id:null}).includes('/123/take-by-supplier'));
  assert.equal(previewCurl(123,{driver_id:4,vehicle_id:5,trailer_id:6}),null);
  assert.throws(()=>previewCurl('123;other',{driver_id:4,vehicle_id:5}));
});

test('assigned and non-created cards never become candidates or curl previews',async()=>{
 const {store,admin}=init();const date=businessDate();const base={route_id:61373,car_dt:date+'T12:00:00+05:00'};const calls=[];
 try{addPlan(store,admin);config(store,admin,{enabled:true});const worker=new BotWorker(store,{fetchImpl:async(url,options)=>{calls.push(url);assert.equal(options.method,'GET');return Response.json({data:url.endsWith('TO_DELIVERY')?[{...base,transport_request_id:100,supplier_id:5},{...base,transport_request_id:101,supplier_id:null}]:{...base,transport_request_id:101,supplier_id:null,request_status:'cancelled',is_closed:false}});}});await worker.tick();const status=store.getBotStatus(admin);assert.equal(calls.length,2);assert.equal(status.runtime.candidates,0);assert.equal(status.events.length,0);assert.equal(status.logs.some(e=>e.kind==='curl_preview'),false);}finally{store.close();}
});
