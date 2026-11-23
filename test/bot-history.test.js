import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {createPortal} from '../src/server.js';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const iso=days=>new Date(Date.now()-days*86400000).toISOString();
function setup(){const store=openStore(':memory:');const admin=store.addUser({username:'root',name:'Root',password:'testing-password-123'},null,true);return {store,admin};}
function log(store,id,at,payload={id:1920998,routeId:61373,httpStatus:200}){store.db.prepare('INSERT INTO bot_logs(id,kind,payload,created_at) VALUES(?,?,?,?)').run(id,'response_received',JSON.stringify(payload),at);}
test('history pages reach beyond old count limits and support date range, filtering, sorting and stable pages',()=>{
 const {store,admin}=setup();try{
 const at=iso(1);store.db.exec('BEGIN');for(let id=1;id<=2105;id++)log(store,id,at);store.db.exec('COMMIT');
 const first=store.botHistoryPage('logs',{size:100},admin);assert.equal(first.total,2105);assert.equal(first.last_page,22);assert.equal(first.data[0].id,2105);
 log(store,2106,iso(0));const last=store.botHistoryPage('logs',{page:22,size:100,maxId:first.maxId},admin);assert.equal(last.total,2105);assert.equal(last.data.at(-1).id,1);
 const range=store.botHistoryPage('logs',{from:at,to:at,q:'1920998',filters:JSON.stringify([{field:'http',value:'200'}]),sorters:JSON.stringify([{field:'id',dir:'asc'}])},admin);assert.equal(range.total,2105);assert.equal(range.data[0].id,1);
 assert.equal(store.botHistoryPage('logs',{q:'1920999'},admin).total,0);
 for(const input of [{page:0},{size:101},{from:'bad'},{from:iso(0),to:iso(1)},{sorters:'[{"field":"id; DROP TABLE users","dir":"asc"}]'},{filters:'null'}])assert.throws(()=>store.botHistoryPage('logs',input,admin));
 assert.throws(()=>store.botHistoryPage('logs',{}, {role:'admin'}),/только администратору/);
 }finally{store.close();}
});
test('retention uses 30/90 days, preserves snapshots after event deletion and protects acceptance state',()=>{
 const {store,admin}=setup();try{
 log(store,1,iso(31));log(store,2,iso(29));
 const insert=table=>{for(const [id,days]of [[1,91],[2,89]])store.db.prepare('INSERT INTO '+table+'(id,kind,payload,created_at) VALUES(?,?,?,?)').run(id,'acceptance_success',JSON.stringify({id,routeId:61373}),iso(days));};insert('bot_events');insert('bot_acceptance_results');
 for(const [id,days]of [[1,91],[2,89]])store.db.prepare('INSERT INTO bot_snapshots(id,payload,created_at) VALUES(?,?,?)').run(id,JSON.stringify({response:{data:[]}}),iso(days));
 store.db.prepare("INSERT INTO acceptance_attempts VALUES(10,1,1,2,'success',1,?,0,'{}','{}')").run(Date.now()-91*86400000);
 store.db.prepare("INSERT INTO acceptance_attempts VALUES(11,2,3,4,'uncertain',1,?,0,'{}','{}')").run(Date.now()-91*86400000);
 store.cleanupBotHistory(Date.now(),true);
 for(const table of ['bot_logs','bot_events','bot_snapshots','bot_acceptance_results'])assert.deepEqual(store.db.prepare('SELECT id FROM '+table).all().map(r=>r.id),[2]);
 const claims=store.db.prepare('SELECT * FROM acceptance_attempts ORDER BY id').all();assert.equal(claims[0].state,'success');assert.equal(claims[0].response,null);assert.equal(claims[1].response,'{}');
 store.deleteBotEvent(2,admin);store.cleanupBotHistory(Date.now(),true);assert.deepEqual(store.getBotSnapshot(2,admin),{response:{data:[]}});
 }finally{store.close();}
});
test('event page includes its acceptance result and endpoints enforce administrator access',async()=>{
 const {store,admin}=setup();const at=iso(0),payload={id:123,routeId:61373};store.db.prepare('INSERT INTO bot_events VALUES(1,?,?,?)').run('candidate_found',JSON.stringify(payload),at);store.db.prepare('INSERT INTO bot_acceptance_results VALUES(123,?,?,?)').run('acceptance_error',JSON.stringify({...payload,message:'Conflict'}),at);
 const server=createPortal({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{
 assert.equal((await fetch(origin+'/api/bot/history/events')).status,401);
 const manager=store.addUser({username:'manager',name:'Manager',password:'testing-password-123',role:'admin'},admin);
 const logist=store.addUser({username:'logist',name:'Logist',password:'testing-password-123',role:'logist'},admin);
 store.db.prepare('UPDATE bot_events SET payload=? WHERE id=1').run(JSON.stringify({...payload,curl:'private-curl',snapshotId:99,previewNote:'private-diagnostic'}));
 for(const user of [manager,logist,admin]){
  const headers={Cookie:'portal_session='+store.createSession(user.id)};
  const response=await fetch(origin+'/api/bot/history/events',{headers});assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.data[0].outcome.payload.message,'Conflict');
  const privileged=user.role==='super_admin';assert.equal(JSON.stringify(body).includes('private-curl'),privileged);assert.equal(JSON.stringify(body).includes('private-diagnostic'),privileged);
  assert.equal((await fetch(origin+'/api/bot/history/logs',{headers})).status,privileged?200:403);
  if(!privileged){
   assert.equal((await fetch(origin+'/api/bot/events/1/delete',{method:'POST',headers})).status,403);
   assert.equal((await fetch(origin+'/api/bot/snapshots/99',{headers})).status,403);
   assert.equal((await fetch(origin+'/api/bot/attempts/123',{headers})).status,403);
  }
 }
 const headers={Cookie:'portal_session='+store.createSession(admin.id)};const summary=await(await fetch(origin+'/api/bot/status?summary=1',{headers})).json();assert.deepEqual(summary.events,[]);
 }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
test('history controls convert portal time explicitly and map remote rows and filter labels',()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),block=source.slice(source.indexOf('const historyRanges='));const context=vm.createContext({URLSearchParams,Date,logNames:{poll_started:'Начало проверки'},monitorTime:v=>v,logSummary:()=>'',acceptanceMarkup:()=>'',state:{bot:{}},document:{}});vm.runInContext(block,context);
 const params=vm.runInContext("historyParams('logs',{page:1,filters:[{field:'event',value:'Начало проверки'}]})",context);assert.equal(JSON.parse(params.get('filters'))[0].value,'poll_started');
 assert.equal(new Date('2026-11-22T02:07:20+05:00').toISOString(),'2026-11-21T21:07:20.000Z');
 assert.match(vm.runInContext("historyControls('logs')",context),/datetime-local/);
 const vendorParams=vm.runInContext("historyParams('logs',{page:2,filter:[{field:'http',value:'403'}],sort:[{field:'time',dir:'asc'}]})",context);assert.equal(JSON.parse(vendorParams.get('sorters'))[0].field,'time');assert.equal(JSON.parse(vendorParams.get('filters'))[0].value,'403');
});
