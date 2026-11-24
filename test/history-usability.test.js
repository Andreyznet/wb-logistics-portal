import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {openStore} from '../src/store.js';
import {seedPreviewDemo} from '../src/server.js';
import {dashboard} from '../src/dashboard.js';

test('stored route names appear on existing plans, dashboard and redacted history for every role',()=>{
 const store=openStore(':memory:');try{
  seedPreviewDemo(store);const name='СЦ Новосибирск 4 (50181287), СЦ Абакан 2 (300862)';
  store.cacheCatalogRows('route',[{id:65522,name}]);
  store.recordBotCandidates([{id:99123,routeId:65522}]);
  store.recordBotLog('poll_started',{routes:[65522],intervalSeconds:15});
  for(const user of store.users()){
   assert.equal(store.requests(user).find(p=>p.route_id===65522).route_name,name);
   const rows=store.botHistoryPage('events',{},user).data;assert.equal(rows.find(e=>e.payload.routeId===65522).payload.routeName,name);
  }
  const root=store.users().find(u=>u.role==='super_admin');assert.equal(dashboard(store,root).upcoming.find(p=>p.routeId===65522).routeName,name);
  assert.equal(store.botHistoryPage('logs',{},root).data.find(e=>e.kind==='poll_started').payload.routeNames[65522],name);
 }finally{store.close();}
});
test('automatic refresh leaves scrolled history untouched and prevents overlapping refreshes',async()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),block=source.slice(source.indexOf('function refreshHistoryTable('),source.indexOf('function mapMonitorHistory('));
 let onScroll;const holder={scrollTop:300,addEventListener:(name,fn)=>{onScroll=fn;},removeEventListener:()=>{}};let calls=0,finish;
 const table={getPage:()=>1,getFilters:()=>[],element:{querySelector:()=>holder},replaceData:()=>{calls++;return new Promise(r=>finish=r);}};
 const context=vm.createContext({document:{activeElement:null},table});vm.runInContext(block,context);
 vm.runInContext('refreshHistoryTable(table)',context);assert.equal(calls,0);assert.equal(holder.scrollTop,300);
 holder.scrollTop=0;vm.runInContext('refreshHistoryTable(table);refreshHistoryTable(table)',context);assert.equal(calls,1);holder.scrollTop=720;onScroll();holder.scrollTop=0;finish();await new Promise(r=>setImmediate(r));assert.equal(table._historyRefreshing,false);assert.equal(holder.scrollTop,720);
});
test('event categories distinguish success, errors, warnings, discovery, requests and monitoring',()=>{
 const source=readFileSync(new URL('../public/history-usability.js',import.meta.url),'utf8'),context=vm.createContext({});vm.runInContext(source,context);
 for(const [kind,http,tone]of [['acceptance_success',200,'success'],['api_recovered',200,'success'],['response_received',503,'error'],['request_failed',0,'error'],['card_access_denied',403,'error'],['no_plans',0,'warning'],['snapshot_saved',0,'discovery'],['request_started',0,'network'],['poll_completed',0,'monitor'],['worker_started',0,'system']]){context.kind=kind;context.http=http;assert.equal(vm.runInContext('logTone(kind,http)',context),tone);}
});
