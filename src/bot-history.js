// Diagnostic retention is independent of durable acceptance claims and plan state.
export function createBotHistory(db,fail){
 if(!db.prepare('PRAGMA table_info(bot_snapshots)').all().some(c=>c.name==='created_at')){
  db.exec('ALTER TABLE bot_snapshots ADD COLUMN created_at TEXT');
  db.prepare("UPDATE bot_snapshots SET created_at=COALESCE(json_extract(payload,'$.receivedAt'),?)").run(new Date().toISOString());
 }
 db.exec(`CREATE INDEX IF NOT EXISTS bot_logs_time ON bot_logs(created_at,id);
 CREATE INDEX IF NOT EXISTS bot_events_time ON bot_events(created_at,id);
 CREATE INDEX IF NOT EXISTS bot_snapshots_time ON bot_snapshots(created_at);
 CREATE INDEX IF NOT EXISTS bot_results_time ON bot_acceptance_results(created_at);`);
 let lastCleanup=0;
 function cleanup(now=Date.now(),force=false){
  if(!force&&now-lastCleanup<3600000)return;lastCleanup=now;
  const cutoff=days=>new Date(now-days*86400000).toISOString();
  db.prepare('DELETE FROM bot_logs WHERE created_at<?').run(cutoff(30));
  for(const table of ['bot_events','bot_snapshots','bot_acceptance_results'])db.prepare('DELETE FROM '+table+' WHERE created_at<?').run(cutoff(90));
  // Keep successful/pending claims forever; only expire bulky diagnostic response bodies.
  if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='acceptance_attempts'").get())db.prepare("UPDATE acceptance_attempts SET response=NULL WHERE updated_at<? AND state NOT IN ('pending','uncertain')").run(now-90*86400000);
 }
 function page(kind,input,actor){
  if(actor?.role!=='super_admin')fail(403,'Журнал доступен только администратору.');
  if(!['logs','events'].includes(kind))fail(400,'Неизвестный журнал.');cleanup();
  const page=Number(input.page??1),size=Number(input.size??30);
  if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isSafeInteger(size)||size<1||size>100)fail(400,'Некорректная страница.');
  const table=kind==='logs'?'bot_logs':'bot_events';
  const maxId=input.maxId==null?db.prepare('SELECT COALESCE(max(id),0) AS id FROM '+table).get().id:Number(input.maxId);
  if(!Number.isSafeInteger(maxId)||maxId<0)fail(400,'Некорректная граница журнала.');
  const clauses=['e.id<=?'],args=[maxId];
  for(const [key,op]of [['from','>='],['to','<=']])if(input[key]){
   if(typeof input[key]!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(input[key])||!Number.isFinite(Date.parse(input[key])))fail(400,'Некорректная дата журнала.');
   clauses.push('e.created_at'+op+'?');args.push(new Date(input[key]).toISOString());
  }
  if(input.from&&input.to&&Date.parse(input.from)>Date.parse(input.to))fail(400,'Начало периода позже окончания.');
  const fields=kind==='logs'?{id:'e.id',time:'e.created_at',event:'e.kind',routes:"COALESCE(json_extract(e.payload,'$.routes'),json_extract(e.payload,'$.routeId'))",http:"json_extract(e.payload,'$.httpStatus')",duration:"json_extract(e.payload,'$.durationMs')",result:'e.payload',requestId:"json_extract(e.payload,'$.id')"}:{id:'e.id',requestId:"json_extract(e.payload,'$.id')",routeId:"json_extract(e.payload,'$.routeId')",carTime:"julianday(json_extract(e.payload,'$.carDt'))",foundTime:'e.created_at',event:'e.kind',outcomeText:'r.payload'};
  const contains=(expr,value)=>{clauses.push('CAST('+expr+" AS TEXT) LIKE ? ESCAPE '!' ");args.push('%'+String(value).replaceAll('!','!!').replaceAll('%','!%').replaceAll('_','!_')+'%');};
  if(input.q){if(typeof input.q!=='string'||input.q.length>200)fail(400,'Слишком длинный поиск.');contains("e.kind||' '||e.payload",input.q);}
  let filters=[],sorters=[];try{filters=JSON.parse(input.filters||'[]');sorters=JSON.parse(input.sorters||'[]');}catch{fail(400,'Некорректные фильтры.');}
  if(!Array.isArray(filters)||filters.length>10||!Array.isArray(sorters)||sorters.length>5)fail(400,'Некорректные фильтры.');
  for(const f of filters){if(!f||!Object.hasOwn(fields,f.field)||typeof f.value!=='string'||f.value.length>200)fail(400,'Некорректный фильтр.');contains(fields[f.field],f.value);}
  const order=sorters.map(s=>{if(!s||!Object.hasOwn(fields,s.field)||!['asc','desc'].includes(s.dir))fail(400,'Некорректная сортировка.');return fields[s.field]+' '+s.dir;});order.push('e.id DESC');
  const join=kind==='events'?" LEFT JOIN bot_acceptance_results r ON r.id=json_extract(e.payload,'$.id')":'',where=clauses.length?' WHERE '+clauses.join(' AND '):'';
  const total=db.prepare('SELECT count(*) AS n FROM '+table+' e'+join+where).get(...args).n;
  const rows=db.prepare('SELECT e.*'+(kind==='events'?',r.kind AS outcome_kind,r.payload AS outcome_payload':'')+' FROM '+table+' e'+join+where+' ORDER BY '+order.join(',')+' LIMIT ? OFFSET ?').all(...args,size,(page-1)*size).map(row=>({...row,payload:JSON.parse(row.payload),...(row.outcome_payload?{outcome:{kind:row.outcome_kind,payload:JSON.parse(row.outcome_payload)}}:{})}));
  return {data:rows,total,maxId,last_page:Math.max(1,Math.ceil(total/size)),last_row:total};
 }
 return {cleanupBotHistory:cleanup,botHistoryPage:page};
}
