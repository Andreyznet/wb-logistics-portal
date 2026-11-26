import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,businessDate} from '../src/store.js';
import {BotWorker} from '../src/bot.js';
import {monitoredFetch} from '../src/api-monitor.js';
import {createPortal} from '../src/server.js';
function setup(){const store=openStore(':memory:'),root=store.addUser({username:'root',name:'Root',password:'test-password-123'},null,true);return {store,root};}

test('every successful list response is archived before filtering including non-created and assigned records',async()=>{
 const {store,root}=setup();try{
 store.importDirectory({transport:{drivers:[{id:1,name:'Driver'}],vehicles:[{id:2,name:'Truck'}],trailers:[]}},root.id);store.saveRequest({routeId:65522,serviceDate:businessDate(),driverId:1,vehicleId:2,observeOnly:true},root);
 store.saveBotSettings({...store.getBotSettings(root),enabled:true,token:'private-test-token',supplierId:0},root);
 const response={data:[{transport_request_id:100,route_id:65522,supplier_id:123,request_status:'in_progress',is_closed:false,extra:{preserved:true}}]};let now=new Date(),calls=0;
 const worker=new BotWorker(store,{clock:()=>now,fetchImpl:async()=>{calls++;return Response.json(response);}});await worker.tick();now=new Date(now.getTime()+61000);await worker.tick();assert.equal(calls,2);assert.equal(store.userAlerts(root).length,0);
 const rows=[...store.wbResponseExport({},root)()];assert.equal(rows.length,2);assert.deepEqual(rows[0].response,response);assert.equal(rows[0].httpStatus,200);assert.equal(rows[0].format,'json');assert.equal(store.db.prepare('SELECT count(*) AS n FROM wb_response_bodies').get().n,1);
 }finally{store.close();}
});

test('archive keeps error JSON and non-JSON text, hides credentials and leaves caller response intact',async()=>{
 const {store,root}=setup();try{
 const token='secret-bearer-value',response={error:{message:'Echo '+token},Authorization:'Bearer '+token,refresh_token:'hidden-refresh'};
 let next=Response.json(response,{status:400});const wrapped=monitoredFetch(store,async()=>next),options={method:'POST',headers:{Authorization:'Bearer '+token}};
 const result=await wrapped('https://logistics.wb.ru/router-bff/routecar/v1/routecars',options);assert.deepEqual(await result.json(),response);const saved=store.getWbResponse(result.archiveId,root);assert.equal(saved.httpStatus,400);assert.equal(JSON.stringify(saved).includes(token),false);assert.equal(JSON.stringify(saved).includes('hidden-refresh'),false);
 next=new Response('<html>Unavailable</html>',{status:503,headers:{'Content-Type':'text/html'}});const text=await wrapped('https://logistics.wb.ru/test',options);assert.equal((await text.text()),'<html>Unavailable</html>');assert.equal(store.getWbResponse(text.archiveId,root).rawText,'<html>Unavailable</html>');
 }finally{store.close();}
});

test('admin downloads full JSON by period; retention removes old references without deleting shared fresh bodies',async()=>{
 const {store,root}=setup(),manager=store.addUser({username:'manager',name:'Manager',role:'admin',password:'test-password-123'},root);const now=new Date().toISOString(),old=new Date(Date.now()-31*86400000).toISOString();
 const record=at=>store.recordWbResponse({requestId:'test',at,method:'GET',url:'https://logistics.wb.ru/list',httpStatus:200,contentType:'application/json',text:'{"data":[]}'});record(old);const id=record(now);store.cleanupBotHistory(Date.now(),true);assert.equal([...store.wbResponseExport({},root)()].length,1);assert.equal(store.db.prepare('SELECT count(*) AS n FROM wb_response_bodies').get().n,1);
 const server=createPortal({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 try{
 for(const path of ['/api/bot/responses/'+id,'/api/bot/responses/export']){assert.equal((await fetch(origin+path)).status,401);assert.equal((await fetch(origin+path,{headers:{Cookie:'portal_session='+store.createSession(manager.id)}})).status,403);}
 const headers={Cookie:'portal_session='+store.createSession(root.id)};const exported=await fetch(origin+'/api/bot/responses/export?from='+encodeURIComponent(now)+'&to='+encodeURIComponent(now),{headers});assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition'),/wb-responses.json/);assert.deepEqual((await exported.json()).responses.map(r=>r.id),[id]);
 assert.equal((await fetch(origin+'/api/bot/responses/export?from=bad',{headers})).status,400);
 for(let n=0;n<205;n++)record(now);const bulk=await(await fetch(origin+'/api/bot/responses/export',{headers})).json();assert.equal(bulk.responses.length,206);assert.deepEqual(bulk.responses[0].response,{data:[]});
 }finally{await new Promise(r=>server.close(r));store.close();}
});


test('complete response archive survives a process restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wb-response-')),file=join(dir,'portal.sqlite');let store=openStore(file);
 try{const root=store.addUser({username:'root',name:'Root',password:'test-password-123'},null,true);const id=store.recordWbResponse({requestId:'persisted',at:new Date().toISOString(),method:'GET',url:'https://logistics.wb.ru/transport-requests-service/api/v1/transport-requests?filter=TO_DELIVERY',httpStatus:200,contentType:'application/json',text:'{"data":[{"route_id":65522,"request_status":"in_progress","supplier_id":100}]}' });store.close();store=openStore(file);assert.equal(store.getWbResponse(id,root).response.data[0].request_status,'in_progress');assert.equal(store.getWbResponse(id,root).requestId,'persisted');}finally{store.close();await rm(dir,{recursive:true,force:true});}
});
