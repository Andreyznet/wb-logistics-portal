import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
export function createResponseArchive({db,transaction,fail}){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_response_bodies(hash TEXT PRIMARY KEY,body BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS wb_responses(id INTEGER PRIMARY KEY,request_id TEXT NOT NULL,created_at TEXT NOT NULL,method TEXT NOT NULL,url TEXT NOT NULL,http_status INTEGER NOT NULL,content_type TEXT NOT NULL,body_hash TEXT NOT NULL REFERENCES wb_response_bodies(hash));
 CREATE INDEX IF NOT EXISTS wb_responses_time ON wb_responses(created_at,id);`);
 const requireAdmin=actor=>{if(actor?.role!=='super_admin')fail(403,'Ответы WB доступны только администратору.');};
 function recordWbResponse(input,token=''){
  const scrub=v=>typeof v==='string'?(token?v.replaceAll(token,'[скрыто]'):v).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[скрыто]'):Array.isArray(v)?v.map(scrub):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,value])=>[k,/^(authorization|access_token|refresh_token|token)$/i.test(k)?'[скрыто]':scrub(value)])):v;
  let payload;try{payload={format:'json',response:scrub(JSON.parse(input.text))};}catch{payload={format:'text',rawText:scrub(input.text??''),...(input.bodyError?{bodyError:input.bodyError}:{})};}
  const text=JSON.stringify(payload),hash=createHash('sha256').update(text).digest('hex'),compressed=gzipSync(text);
  return transaction(()=>{db.prepare('INSERT OR IGNORE INTO wb_response_bodies VALUES(?,?)').run(hash,compressed);return Number(db.prepare('INSERT INTO wb_responses(request_id,created_at,method,url,http_status,content_type,body_hash) VALUES(?,?,?,?,?,?,?)').run(input.requestId,input.at,input.method,scrub(input.url),input.httpStatus,input.contentType||'',hash).lastInsertRowid);});
 }
 function decode(row){return {id:row.id,requestId:row.request_id,receivedAt:row.created_at,method:row.method,url:row.url,httpStatus:row.http_status,contentType:row.content_type,...JSON.parse(gunzipSync(row.body).toString('utf8'))};}
 function getWbResponse(id,actor){requireAdmin(actor);const row=db.prepare('SELECT r.*,b.body FROM wb_responses r JOIN wb_response_bodies b ON b.hash=r.body_hash WHERE r.id=?').get(id);if(!row)fail(404,'Ответ WB не найден или срок хранения истёк.');return decode(row);}
 function wbResponseExport(input,actor){
  requireAdmin(actor);const clauses=['r.id<=?'],args=[db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM wb_responses').get().id];
  for(const [key,op]of [['from','>='],['to','<=']])if(input[key]){if(typeof input[key]!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(input[key])||!Number.isFinite(Date.parse(input[key])))fail(400,'Некорректная дата архива.');clauses.push('r.created_at'+op+'?');args.push(new Date(input[key]).toISOString());}
  if(input.from&&input.to&&Date.parse(input.from)>Date.parse(input.to))fail(400,'Начало периода позже окончания.');
  return function*(){let after=0;while(true){const rows=db.prepare('SELECT r.*,b.body FROM wb_responses r JOIN wb_response_bodies b ON b.hash=r.body_hash WHERE '+clauses.join(' AND ')+' AND r.id>? ORDER BY r.id LIMIT 100').all(...args,after);if(!rows.length)return;for(const row of rows){after=row.id;yield decode(row);}}};
 }
 function cleanupWbResponses(now){db.prepare('DELETE FROM wb_responses WHERE created_at<?').run(new Date(now-30*86400000).toISOString());db.exec('DELETE FROM wb_response_bodies WHERE hash NOT IN (SELECT body_hash FROM wb_responses)');}
 return {recordWbResponse,getWbResponse,wbResponseExport,cleanupWbResponses};
}
