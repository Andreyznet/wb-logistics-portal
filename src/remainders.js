import {createHash} from 'node:crypto';
import {monitoredFetch} from './api-monitor.js';
import {fail} from './store.js';
export const REMAINDERS_URL='https://logistics.wb.ru/reports-service/api/v1/containers/src-offices';
const TTL=300000;
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0;
export function routeOffices(route){
 if(positive(route.src_office_id)&&Array.isArray(route.dst_office_ids))return route.dst_office_ids.length===1&&positive(route.dst_office_ids[0])?[Number(route.src_office_id),Number(route.dst_office_ids[0])]:null;
 const ids=[...(route.name||'').matchAll(/\((\d+)\)/g)].map(m=>Number(m[1]));
 return ids.length===2&&ids.every(positive)?ids:null;
}
export function parseRemainders(payload){
 if(!Array.isArray(payload?.data)||payload.error)throw new Error('Некорректный ответ отчёта остатков WB.');
 const result={};
 for(const source of payload.data){
  if(!positive(source.src_office_id)||!Array.isArray(source.route_legs))throw new Error('Некорректные данные склада WB.');
  for(const leg of source.route_legs){
   if(!positive(leg.dst_office_id))continue;
   if(!Array.isArray(leg.contents))throw new Error('Некорректное содержимое плеча WB.');
   let containers=0,shk=0;
   for(const item of leg.contents){
    for(const key of ['container_count','shk_count'])if(!/^[0-9]+$/.test(String(item[key]))||!Number.isSafeInteger(Number(item[key])))throw new Error('Некорректное количество в отчёте WB.');
    containers+=Number(item.container_count);shk+=Number(item.shk_count);
   }
   if(!Number.isSafeInteger(containers)||!Number.isSafeInteger(shk))throw new Error('Некорректная сумма остатков WB.');
   const key=source.src_office_id+':'+leg.dst_office_id;
   result[key]=Object.hasOwn(result,key)?null:{containers,shk,reportedAt:source.dt||null};
  }
 }
 return result;
}
export function createRemainders(store,{fetchImpl=fetch,clock=Date.now}={}){
 const request=monitoredFetch(store,fetchImpl);let pending=null,lastAttempt=0;
 const scope=()=>{const c=store.botConfig();return createHash('sha256').update((c.token||'')+':'+c.supplierId).digest('hex');};
 const read=()=>{const row=store.db.prepare("SELECT value FROM settings WHERE key='remainders_cache'").get();if(!row)return null;const saved=JSON.parse(row.value);return saved.scope===scope()?saved:null;};
 function snapshot(){const saved=read(),routes=store.db.prepare("SELECT id,payload FROM catalog WHERE kind='route'").all(),data={};for(const route of routes){const pair=routeOffices(JSON.parse(route.payload));data[route.id]=pair?saved?.data[pair.join(':')]??null:null;}return {data,fetchedAt:saved?.fetchedAt||null,stale:!saved||clock()-saved.fetchedAt>=TTL};}
 async function refresh(){
  const saved=read();if(saved&&clock()-saved.fetchedAt<TTL)return snapshot();if(pending)return pending;
  if(lastAttempt&&clock()-lastAttempt<30000)fail(429,'Повторите обновление остатков через 30 секунд.');
  lastAttempt=clock();const initialScope=scope();
  pending=(async()=>{const config=store.botConfig();if(!config.token)fail(409,'Сначала сохраните токен WB в настройках бота.');let response;try{response=await request(REMAINDERS_URL,{method:'GET',headers:{Accept:'application/json',Authorization:'Bearer '+config.token},signal:AbortSignal.timeout(20000),redirect:'manual'});}catch{fail(502,'Не удалось загрузить остатки WB. Сохранённые данные оставлены.');}
   if(response.status!==200)fail(502,'WB вернул HTTP '+response.status+' при загрузке остатков. Сохранённые данные оставлены.');
   let data;try{data=parseRemainders(await response.json());}catch{fail(502,'WB вернул некорректный отчёт остатков.');}
   if(scope()!==initialScope)fail(409,'Настройки WB изменились. Повторите обновление.');
   store.db.prepare("INSERT INTO settings(key,value) VALUES('remainders_cache',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({scope:initialScope,fetchedAt:clock(),data}));return snapshot();
  })();try{return await pending;}finally{pending=null;}
 }
 return {snapshot,refresh};
}
