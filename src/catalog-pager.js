import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {makeDirectoryApi,parsePartnershipPage,parseTransport,partnershipBody,routecarBody,parseRoutecarPage} from './directory-api.js';
import {fail} from './store.js';
import {monitoredFetch} from './api-monitor.js';
export function createCatalogPager(store,{fetchImpl=fetch,clock=()=>Date.now()}={}){
 fetchImpl=monitoredFetch(store,fetchImpl);
 const key=randomBytes(32),cache=new Map();let transport=null;
 const hash=value=>createHash('sha256').update(value).digest('hex');
 const sign=value=>createHmac('sha256',key).update(value).digest('base64url');
 function pack(data){const encoded=Buffer.from(JSON.stringify(data)).toString('base64url');return encoded+'.'+sign(encoded);}
 function unpack(value,scope,kind,query){try{const [raw,signature,...extra]=value.split('.');if(extra.length||!raw||!signature||signature.length!==sign(raw).length||!timingSafeEqual(Buffer.from(signature),Buffer.from(sign(raw))))throw 0;const result=JSON.parse(Buffer.from(raw,'base64url'));if(result.scope!==scope||result.kind!==kind||result.query!==query)throw 0;return result.cursor;}catch{fail(400,'Страница поиска устарела. Откройте список заново.');}}
 function remember(id,fn){const old=cache.get(id);if(old&&old.until>clock())return old.promise;if(cache.size>=100)cache.delete(cache.keys().next().value);const item={until:clock()+30000,promise:null};item.promise=fn().catch(error=>{if(cache.get(id)===item)cache.delete(id);throw error;});cache.set(id,item);return item.promise;}
 function failureMessage(error,kind){const target=kind==='route'?'маршруты':kind==='driver'?'водителей':'транспорт';if(error.status===401||error.status===403)return 'WB отклонил доступ к справочнику (HTTP '+error.status+'). Обновите токен WB.';if(error.status===429)return 'WB ограничил частоту запросов (HTTP 429). Повторите позже.';if(error.status)return 'WB вернул HTTP '+error.status+' при загрузке справочника. Проверьте ID компании и доступ.';return 'Не удалось загрузить '+target+' WB: ошибка сети или неподдерживаемый ответ API.';}
 function savedPage(kind,query,offset,scope,warning){const result=store.catalogPage(kind,query,offset);return {data:result.data,nextCursor:result.hasMore?pack({scope,kind,query,cursor:{savedOffset:offset+30,warning}}):null,source:'saved',warning};}
 async function page({kind,query='',cursor=null}){
  if(!['route','driver','vehicle','trailer'].includes(kind)||typeof query!=='string'||query.length>100||cursor&&cursor.length>4096)fail(400,'Проверьте параметры поиска.');query=query.trim();
  if(kind==='route'){if(!/^\d{0,10}$/.test(query))fail(400,'Введите номер маршрута цифрами.');if(!query)return {data:[],nextCursor:null,source:'saved'};}
  const config=store.botConfig(),scope=hash(config.token+'|'+config.supplierId),next=cursor?unpack(cursor,scope,kind,query):null;
  if(next&&typeof next==='object'&&Number.isSafeInteger(next.savedOffset)&&next.savedOffset>=0)return savedPage(kind,query,next.savedOffset,scope,next.warning);
  if(!config.token){const offset=next??0;if(!Number.isSafeInteger(offset)||offset<0)fail(400,'Некорректная страница.');const result=store.catalogPage(kind,query,offset);return {data:result.data,nextCursor:result.hasMore?pack({scope,kind,query,cursor:offset+30}):null,source:'saved'};}
  const api=makeDirectoryApi({logisticsHeaders:{Authorization:'Bearer '+config.token},driveHeaders:{Authorization:'Bearer '+config.token}},fetchImpl);
  if(kind==='route')return remember(hash(scope+'|'+kind+'|'+query+'|'+(cursor||'')),async()=>{
   if(next!==null&&typeof next!=='string')fail(400,'Некорректная страница маршрутов.');
   let parsed;try{parsed=parseRoutecarPage(await api.routecars(routecarBody(query,next||'')));}catch(error){const message=failureMessage(error,kind);const saved=savedPage(kind,query,0,scope,message+' Показаны сохранённые маршруты.');if(saved.data.length)return saved;fail(502,message);}
   if(parsed.nextToken&&parsed.nextToken===next)fail(502,'WB повторил страницу маршрутов. Повторите поиск.');
   return {data:store.cacheCatalogRows('route',parsed.rows),nextCursor:parsed.nextToken?pack({scope,kind,query,cursor:parsed.nextToken}):null,source:'wb'};
  });
  if(kind==='driver'){
   if(/^[78]\d{10}$/.test(String(config.supplierId)))fail(400,'В ID компании указан телефон. Укажите supplier_id WB: 10095401 для вашей организации.');
   if(!Number.isSafeInteger(config.supplierId)||config.supplierId<=0)fail(400,'Укажите ID компании в настройках бота для поиска водителей WB.');
   return remember(hash(scope+'|'+kind+'|'+query+'|'+(cursor||'')),async()=>{
    const body=partnershipBody(config.supplierId,next);if(query)body.data.query=query;
    let parsed;try{parsed=parsePartnershipPage(await api.partnerships(body));}catch(error){const message=failureMessage(error,kind);const saved=savedPage(kind,query,0,scope,message+' Показан сохранённый справочник.');if(saved.data.length)return saved;fail(502,message);}
    if(parsed.nextToken===next&&parsed.nextToken)fail(502,'WB повторил страницу водителей. Повторите поиск.');
    const data=store.cacheCatalogRows('driver',parsed.rows.map(row=>({id:row.id,name:row.name})));
    return {data,nextCursor:parsed.nextToken?pack({scope,kind,query,cursor:parsed.nextToken}):null,source:'wb'};
   });
  }
  // This verified WB endpoint returns the complete vehicle/trailer directory. Cache it once,
  // then serve small searched pages to the browser; do not guess undocumented WB filters.
  if(!transport||transport.scope!==scope||transport.until<=clock()){
   const item={scope,until:clock()+60000,promise:null};item.promise=(async()=>{try{const data=parseTransport(await api.transport());store.cacheCatalogRows('vehicle',data.vehicles,{replace:true});store.cacheCatalogRows('trailer',data.trailers,{replace:true});}catch(error){if(transport===item)transport=null;throw error;}})();transport=item;
  }
  try{await transport.promise;}catch(error){const message=failureMessage(error,kind);const saved=savedPage(kind,query,0,scope,message+' Показан сохранённый справочник.');if(saved.data.length)return saved;fail(502,message);}
  const offset=next??0;if(!Number.isSafeInteger(offset)||offset<0)fail(400,'Некорректная страница.');const result=store.catalogPage(kind,query,offset);
  return {data:result.data,nextCursor:result.hasMore?pack({scope,kind,query,cursor:offset+30}):null,source:'wb-cache'};
 }
 return {page,clear(){cache.clear();transport=null;}};
}
