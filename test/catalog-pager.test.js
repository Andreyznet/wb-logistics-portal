import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {openStore} from '../src/store.js';
import {createCatalogPager} from '../src/catalog-pager.js';
const reply=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function setup(){const store=openStore(':memory:');const admin=store.addUser({username:'admin',name:'Admin',password:'testing-password-123'},null,true);store.saveBotSettings({...store.getBotSettings(admin),supplierId:10095401,token:'test-token-value'},admin);return {store,admin};}
test('driver pages send WB query and cursor, coalesce identical requests and cache validated IDs',async()=>{
 const {store}=setup(),calls=[];try{const pager=createCatalogPager(store,{fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return reply({success:true,data:[{id:body.meta.page_token?2:1,name:'Семенов',status:'active'}],meta:{next_page_token:body.meta.page_token?null:'page-two'}});}});
 const [first,same]=await Promise.all([pager.page({kind:'driver',query:'Семенов'}),pager.page({kind:'driver',query:'Семенов'})]);assert.equal(calls.length,1);assert.deepEqual(first,same);assert.deepEqual(calls[0],{data:{is_rental_enabled:null,supplier_id:10095401,query:'Семенов'},meta:{page_size:30,page_token:null}});
 const second=await pager.page({kind:'driver',query:'Семенов',cursor:first.nextCursor});assert.equal(second.data[0].id,2);assert.equal(calls[1].meta.page_token,'page-two');assert.equal(second.nextCursor,null);assert.equal(store.catalogPage('driver','Семенов').data.length,2);
 await assert.rejects(()=>pager.page({kind:'driver',query:'Иванов',cursor:first.nextCursor}),/устарела/);assert.equal(calls.length,2);assert.equal(JSON.stringify(first).includes('test-token-value'),false);
 }finally{store.close();}
});
test('vehicles and trailers use a shared WB cache and return searched pages of 30',async()=>{
 const {store}=setup();let calls=0;try{const pager=createCatalogPager(store,{fetchImpl:async()=>{calls++;return reply({data:{drivers:[],vehicles:Array.from({length:65},(_,i)=>({id:i+1,name:'Тягач',number_plate:'А'+String(i).padStart(3,'0')})),trailers:[{id:100,name:'Прицеп',number_plate:'П001'}]}});}});
 const first=await pager.page({kind:'vehicle'});assert.equal(first.data.length,30);const second=await pager.page({kind:'vehicle',cursor:first.nextCursor});assert.equal(second.data.length,30);const third=await pager.page({kind:'vehicle',cursor:second.nextCursor});assert.equal(third.data.length,5);assert.equal(third.nextCursor,null);assert.equal(new Set([...first.data,...second.data,...third.data].map(x=>x.id)).size,65);
 assert.equal((await pager.page({kind:'vehicle',query:'А064'})).data[0].id,65);assert.equal((await pager.page({kind:'trailer'})).data[0].id,100);assert.equal(calls,1);await assert.rejects(()=>pager.page({kind:'trailer',cursor:first.nextCursor}),/устарела/);
 }finally{store.close();}
});
test('saved directory supports Russian case and ё, literal wildcard search, failed WB requests can retry',async()=>{
 const store=openStore(':memory:');try{store.cacheCatalogRows('driver',[{id:1,name:'Семёнов'},{id:2,name:'100% Имя'}]);const local=createCatalogPager(store);assert.equal((await local.page({kind:'driver',query:'СЕМЕНОВ'})).data[0].id,1);assert.equal((await local.page({kind:'driver',query:'%'})).data.length,1);}finally{store.close();}
 const {store:remote}=setup();let calls=0;try{const pager=createCatalogPager(remote,{fetchImpl:async()=>{if(++calls===1)return new Response('',{status:401});return reply({success:true,data:[],meta:{next_page_token:null}});}});await assert.rejects(()=>pager.page({kind:'driver'}),/Проверьте токен/);assert.equal((await pager.page({kind:'driver'})).data.length,0);assert.equal(calls,2);}finally{remote.close();}
});
function Collection(){const context=vm.createContext({AbortController,Set});vm.runInContext(readFileSync(new URL('../public/paged-list.js',import.meta.url),'utf8')+';globalThis.Collection=PagedCollection;',context);return context.Collection;}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('incremental UI ignores stale searches and aborts old requests',async()=>{
 const C=Collection(),pending=[];const list=new C(request=>{const d=deferred();pending.push({request,...d});return d.promise;});const old=list.reset('old'),fresh=list.reset('new');assert.equal(pending[0].request.signal.aborted,true);pending[1].resolve({data:[{id:2,label:'New'}],nextCursor:null});await fresh;pending[0].resolve({data:[{id:1,label:'Old'}],nextCursor:null});await old;assert.equal(list.rows.length,1);assert.equal(list.rows[0].id,2);list.destroy();
});
test('incremental UI prevents parallel page requests, preserves rows on error, retries and deduplicates',async()=>{
 const C=Collection(),d=deferred();let calls=0;const list=new C(async()=>{calls++;if(calls===1)return d.promise;if(calls===2)throw new Error('Network unavailable');return {data:[{id:1,label:'One'},{id:2,label:'Two'}],nextCursor:null};});const first=list.reset();assert.equal(await list.loadMore(),false);assert.equal(calls,1);d.resolve({data:[{id:1,label:'One'}],nextCursor:'second'});await first;await list.loadMore();assert.equal(list.rows.length,1);assert.equal(list.nextCursor,'second');assert.match(list.error,/Network/);await list.loadMore();assert.equal(list.rows.length,2);assert.equal(list.done,true);assert.equal(list.error,'');list.destroy();
});
test('incremental UI rejects repeated cursors and ignores responses after disposal',async()=>{
 const C=Collection();const list=new C(async()=>({data:[{id:1,label:'One'}],nextCursor:'same'}));await list.reset();await list.loadMore();assert.match(list.error,/повторил/);const d=deferred(),disposed=new C(()=>d.promise);const pending=disposed.reset();disposed.destroy();d.resolve({data:[{id:9,label:'Nine'}]});await pending;assert.equal(disposed.rows.length,0);
});

test('paged directory HTTP endpoints are available to all logged-in roles and never expose WB token',async()=>{
 const {createPortal}=await import('../src/server.js');const {store,admin}=setup();const users=[admin,store.addUser({username:'manager',name:'Manager',password:'testing-password-123',role:'admin'},admin),store.addUser({username:'logist',name:'Logist',password:'testing-password-123',role:'logist'},admin)];
 const server=createPortal({store,directoryFetch:async()=>reply({success:true,data:[{id:44,name:'Семенов',status:'active'}],meta:{next_page_token:null}})});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{assert.equal((await fetch(origin+'/api/catalog/page?kind=driver')).status,401);assert.equal((await fetch(origin+'/paged-list.js')).status,200);for(const user of users){const token=store.createSession(user.id),headers={Cookie:'portal_session='+token};const response=await fetch(origin+'/api/catalog/page?kind=driver&query='+encodeURIComponent('Семенов'),{headers});assert.equal(response.status,200);const value=await response.json();assert.equal(value.data[0].id,44);assert.equal(JSON.stringify(value).includes('test-token-value'),false);const summary=await(await fetch(origin+'/api/catalog/summary',{headers})).json();assert.equal(summary.drivers.length,0);assert.equal(summary.counts.drivers,1);assert.equal((await fetch(origin+'/api/catalog/page?kind=invalid',{headers})).status,400);}}
 finally{await new Promise(resolve=>server.close(resolve));store.close();}
});
