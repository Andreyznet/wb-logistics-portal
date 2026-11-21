import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createAcceptanceStore } from './acceptance-store.js';
import { join, dirname } from 'node:path';

const configuredSupplierId=()=>{const value=Number(process.env.SUPPLIER_ID||0);return Number.isSafeInteger(value)&&value>=0&&!/^[78]\d{10}$/.test(String(value))?value:0;};
const defaults = () => ({ revision:0, enabled:false, acceptanceEnabled:false,supplierId:configuredSupplierId(),intervalSeconds:60, scheduleEnabled:false, days:[1,2,3,4,5], startTime:'08:00', endTime:'20:00', updatedAt:null });
export function tokenExpiry(token) {
  try { const data=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));return Number.isFinite(data.exp)&&Number.isFinite(new Date(data.exp*1000).getTime()) ? new Date(data.exp*1000).toISOString() : null; } catch { return null; }
}
export function createBotStore({ db, file, timeZone, audit, transaction, fail }) {
  let key;
  if (file === ':memory:') key=randomBytes(32);
  else {
    const keyFile=join(dirname(file),'bot-secret.key');
    try {key=readFileSync(keyFile);}
    catch(error){if(error.code!=='ENOENT')throw error;try{writeFileSync(keyFile,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}key=readFileSync(keyFile);}
    if(key.length!==32)throw new Error('Invalid bot encryption key file');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS bot_observations(id INTEGER PRIMARY KEY,fingerprint TEXT NOT NULL,active INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS acceptance_alerts(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),request_id INTEGER NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,ack_at TEXT,UNIQUE(user_id,request_id)); CREATE TABLE IF NOT EXISTS bot_acceptance_results(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bot_snapshots(id INTEGER PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bot_logs(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bot_events(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const read=(name,fallback)=>{const r=db.prepare('SELECT value FROM settings WHERE key=?').get(name);return r?JSON.parse(r.value):fallback;};
  const write=(name,value)=>db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name,JSON.stringify(value));
  // Discard legacy phone values once, before any API consumer can use them as a supplier ID.
  const legacy=read('bot_config',null);
  if(legacy&&/^[78]\d{10}$/.test(String(legacy.supplierId))){write('bot_config',{...legacy,supplierId:0,enabled:false,acceptanceEnabled:false,revision:(legacy.revision||0)+1});audit(null,'bot_settings_updated',null,'Удалён номер телефона из ID компании. Укажите supplier_id WB.');}
  function encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return{iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};}
  function decrypt(value){if(!value)return '';const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));cipher.setAuthTag(Buffer.from(value.tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]).toString('utf8');}
  const requireAdmin=actor=>{if(!['admin','super_admin'].includes(actor?.role))fail(403,'Настройки бота доступны только менеджеру или администратору.');};
  function getBotSettings(actor){requireAdmin(actor);const config={...defaults(),...read('bot_config',{})};const secret=read('bot_token',null);return {...config,requestsPerMinute:config.requestsPerMinute??Math.min(60,Math.max(1,Math.round(60/config.intervalSeconds))),timeZone,hasToken:Boolean(secret),tokenExpiresAt:secret?tokenExpiry(decrypt(secret)):null};}
  function saveBotSettings(input,actor){
    requireAdmin(actor);
    if(typeof input.enabled!=='boolean'||typeof input.scheduleEnabled!=='boolean')fail(400,'Укажите состояние бота и расписания.');
    const rate=input.requestsPerMinute??60/input.intervalSeconds;
    if(!Number.isInteger(rate)||rate<1||rate>60)fail(400,'Агрессивность бота — целое число от 1 до 60 проверок в минуту.');
    let intervalSeconds=60/rate;
    if(!Array.isArray(input.days)||input.days.some(day=>!Number.isInteger(day)||day<1||day>7)||input.days.length!==new Set(input.days).size||input.scheduleEnabled&&!input.days.length)fail(400,'Выберите дни работы бота.');
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.endTime)||input.scheduleEnabled&&input.startTime===input.endTime)fail(400,'Укажите корректное время начала и окончания. Для круглосуточной работы отключите расписание.');
    if(input.clearToken!==undefined&&typeof input.clearToken!=='boolean')fail(400,'Некорректная настройка токена.');
    let supplied='';
    if(input.token!==undefined){if(typeof input.token!=='string')fail(400,'Токен должен быть строкой.');supplied=input.token.trim().replace(/^Bearer\s+/i,'');if(supplied&&(supplied.length<10||supplied.length>16384||/\s/.test(supplied)))fail(400,'Проверьте токен: в нём не должно быть пробелов или переносов строк.');}
    if(supplied&&input.clearToken)fail(400,'Нельзя одновременно заменить и удалить токен.');
    return transaction(()=>{
      const current={...defaults(),...read('bot_config',{})};
      if(input.revision!==current.revision)fail(409,'Настройки изменены другим администратором. Обновите страницу.');
      const currentRate=current.requestsPerMinute??Math.min(60,Math.max(1,Math.round(60/current.intervalSeconds)));
      const frequencyChanged=input.requestsPerMinute===undefined?input.intervalSeconds!==current.intervalSeconds:rate!==currentRate;
      if(current.enabled&&!frequencyChanged)intervalSeconds=current.intervalSeconds;
      if(current.enabled&&((supplied&&supplied!==decrypt(read('bot_token',null)))||input.clearToken||frequencyChanged||(input.acceptanceEnabled??current.acceptanceEnabled)!==current.acceptanceEnabled||(input.supplierId??current.supplierId)!==current.supplierId||input.scheduleEnabled||JSON.stringify(input.days)!==JSON.stringify(current.days)||input.startTime!==current.startTime||input.endTime!==current.endTime))fail(409,'Сначала выключите бота, чтобы изменить настройки.');
      const secret=input.clearToken?null:supplied?encrypt(supplied):read('bot_token',null);
      if(input.enabled&&!secret)fail(400,'Перед включением сохраните токен WB.');
      const exp=secret?tokenExpiry(decrypt(secret)):null;
      if(input.enabled&&exp&&Date.parse(exp)<=Date.now())fail(400,'Срок токена истёк. Введите новый токен.');
      const acceptanceEnabled=input.acceptanceEnabled??current.acceptanceEnabled,supplierId=input.supplierId??current.supplierId;
      if(typeof acceptanceEnabled!=='boolean'||!Number.isSafeInteger(supplierId)||supplierId<0||acceptanceEnabled&&supplierId===0)fail(400,'Для боевого режима укажите ID своего перевозчика (supplier_id).');
      if(/^[78]\d{10}$/.test(String(supplierId)))fail(400,'В ID компании введён номер телефона. Нужен supplier_id из ответа WB, а не логин.');
      write('bot_token',secret);
      write('bot_config',{revision:current.revision+1,enabled:input.enabled,acceptanceEnabled,supplierId,intervalSeconds,requestsPerMinute:rate,scheduleEnabled:false,days:input.days,startTime:input.startTime,endTime:input.endTime,updatedAt:new Date().toISOString()});
      audit(actor.id,'bot_settings_updated',null,`Бот ${input.enabled?'включён':'выключен'}; опрос ${intervalSeconds} сек.; принятие ${acceptanceEnabled?'боевое':'только cURL'}; ID компании ${supplierId}; расписание ${input.scheduleEnabled?'включено':'выключено'}${supplied?'; токен заменён':input.clearToken?'; токен удалён':''}`);
      setBotRuntime(input.enabled?{state:'starting',nextPollAt:null,error:null,warning:null}:{state:'stopped',nextPollAt:null,error:null,warning:null});
      return getBotSettings(actor);
    });
  }
  function botConfig(){return {...defaults(),...read('bot_config',{}),token:decrypt(read('bot_token',null)),timeZone};}
  function stopBot(reason){const config=read('bot_config',defaults());if(config.enabled){write('bot_config',{...config,enabled:false,revision:config.revision+1,updatedAt:new Date().toISOString()});audit(null,'bot_stopped',null,reason);}}
  function setBotRuntime(runtime){const old=read('bot_runtime',{});const value={...old,...runtime};if(JSON.stringify(old)!==JSON.stringify(value))write('bot_runtime',value);return value;}
  function getBotStatus(actor){requireAdmin(actor);if(actor.role!=='super_admin')return {runtime:read('bot_config',defaults()).enabled?read('bot_runtime',{state:'starting'}):{...read('bot_runtime',{}),state:'stopped',nextPollAt:null},events:[],logs:[],outcomes:[]};return {outcomes:db.prepare('SELECT * FROM bot_acceptance_results').all().map(r=>({...r,payload:JSON.parse(r.payload)})),serverVersion:'0.15.0',runtime:read('bot_config',defaults()).enabled?read('bot_runtime',{state:'starting'}):{...read('bot_runtime',{}),state:'stopped',nextPollAt:null},logs:db.prepare('SELECT * FROM bot_logs ORDER BY id DESC LIMIT 100').all().map(row=>({...row,payload:JSON.parse(row.payload)})),events:db.prepare('SELECT id,kind,payload,created_at FROM bot_events ORDER BY id DESC LIMIT 1000').all().map(row=>({...row,payload:JSON.parse(row.payload)}))};}
  function recordBotCandidates(candidates,snapshot=null){return transaction(()=>{
    const old=new Map(db.prepare('SELECT * FROM bot_observations').all().map(row=>[row.id,row]));
    db.exec('UPDATE bot_observations SET active=0');
    let events=0,snapshotId=null;
    for(const row of candidates){const payload=JSON.stringify(row),hash=createHash('sha256').update(payload).digest('hex'),previous=old.get(row.id);if(!previous||!previous.active||previous.fingerprint!==hash){if(snapshot&&!snapshotId)snapshotId=Number(db.prepare('INSERT INTO bot_snapshots(payload) VALUES(?)').run(JSON.stringify(snapshot)).lastInsertRowid);const eventPayload={...row,...(snapshotId?{snapshotId}:{})};db.prepare('INSERT INTO bot_events(kind,payload,created_at) VALUES(?,?,?)').run(previous?.active?'candidate_updated':'candidate_found',JSON.stringify(eventPayload),new Date().toISOString());recordBotLog('curl_preview',eventPayload);if(snapshotId)recordBotLog('snapshot_saved',{id:row.id,routeId:row.routeId,snapshotId});events++;}db.prepare('INSERT INTO bot_observations VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,active=1,payload=excluded.payload').run(row.id,hash,payload);}
    db.exec('DELETE FROM bot_events WHERE id NOT IN (SELECT id FROM bot_events ORDER BY id DESC LIMIT 1000)');db.exec("DELETE FROM bot_snapshots WHERE id NOT IN (SELECT json_extract(payload,'$.snapshotId') FROM bot_events WHERE json_extract(payload,'$.snapshotId') IS NOT NULL)");return events;
  });}
  function recordBotLog(kind,payload){
    const at=new Date().toISOString();
    db.prepare('INSERT INTO bot_logs(kind,payload,created_at) VALUES(?,?,?)').run(kind,JSON.stringify(payload),at);
    db.exec('DELETE FROM bot_logs WHERE id NOT IN (SELECT id FROM bot_logs ORDER BY id DESC LIMIT 2000)');
    console.log(JSON.stringify({at,type:kind,...payload}));
  }
  function getBotSnapshot(id,actor){if(actor?.role!=='super_admin')fail(403,'Ответы WB доступны только администратору.');const row=db.prepare('SELECT payload FROM bot_snapshots WHERE id=?').get(id);if(!row)fail(404,'Снимок ответа не найден.');return JSON.parse(row.payload);}
  function recordAcceptanceResult({id,routeId,httpStatus,response,expected,inTransaction=false}){
    if(!Number.isSafeInteger(id)||id<=0)fail(400,'Некорректный ID заявки.');
    const card=response?.data;
    const success=httpStatus>=200&&httpStatus<300&&response?.success!==false&&card?.transport_request_id===id&&Number.isSafeInteger(card.supplier_id)&&card.supplier_id>0&&expected?.driverId===card.driver_id&&expected?.vehicleId===card.vehicle_id&&(expected.supplierId===undefined||expected.supplierId===card.supplier_id)&&(expected.routeId===undefined||expected.routeId===card.route_id);
    const message=success?'WB подтвердил назначение выбранного водителя и автомобиля.':String(response?.error?.message||response?.message||('Принятие не подтверждено. HTTP '+httpStatus)).slice(0,2000);
    const kind=success?'acceptance_success':'acceptance_error',payload={id,routeId,httpStatus,message},at=new Date().toISOString();
    const persist=()=>{db.prepare('INSERT INTO bot_acceptance_results VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,created_at=excluded.created_at').run(id,kind,JSON.stringify(payload),at);recordBotLog(kind,payload);
      if(success){const observation=db.prepare('SELECT payload FROM bot_observations WHERE id=?').get(id);const candidate=observation?JSON.parse(observation.payload):{};const plan=db.prepare('SELECT * FROM requests WHERE id=?').get(expected?.planId||candidate.planId||0);
        if(plan&&plan.driver_id===card.driver_id&&plan.vehicle_id===card.vehicle_id&&plan.route_id===(card.route_id??routeId)){const notice={id,planId:plan.id,routeId:plan.route_id,routeName:card.route_name||'',carDt:card.car_dt||candidate.carDt||null,driver:plan.driver_label,vehicle:plan.vehicle_label,trailer:plan.trailer_label||null,message};const recipients=db.prepare('SELECT id,name FROM users WHERE id=? OR id IN (SELECT user_id FROM request_watchers WHERE request_id=?)').all(plan.created_by,plan.id),author=recipients.find(u=>u.id===plan.created_by)?.name||'';for(const recipient of recipients)db.prepare('INSERT OR IGNORE INTO acceptance_alerts(user_id,request_id,payload,created_at) VALUES(?,?,?,?)').run(recipient.id,id,JSON.stringify({...notice,watching:recipient.id!==plan.created_by,author}),at);}
      }
    };if(inTransaction)persist();else transaction(persist);return {kind,payload,created_at:at};
  }
  function userAlerts(actor){if(!actor?.id)fail(401,'Войдите в аккаунт.');return db.prepare('SELECT id,payload,created_at FROM acceptance_alerts WHERE user_id=? AND ack_at IS NULL ORDER BY id LIMIT 30').all(actor.id).map(r=>({...r,payload:JSON.parse(r.payload)}));}
  function acknowledgeAlert(id,actor){if(!actor?.id)fail(401,'Войдите в аккаунт.');const row=db.prepare('SELECT id FROM acceptance_alerts WHERE id=? AND user_id=?').get(id,actor.id);if(!row)fail(404,'Уведомление не найдено.');db.prepare('UPDATE acceptance_alerts SET ack_at=COALESCE(ack_at,?) WHERE id=?').run(new Date().toISOString(),id);return {ok:true};}
  function createTestAlert(planId,actor){
    requireAdmin(actor);let plan=null;
    if(planId!=null){if(!Number.isSafeInteger(planId)||planId<1)fail(400,'Выберите план.');plan=db.prepare('SELECT * FROM requests WHERE id=?').get(planId);if(!plan)fail(404,'План не найден.');}
    const userId=plan?.created_by||actor.id,owner=db.prepare('SELECT name FROM users WHERE id=?').get(userId);
    const payload={test:true,id:'ТЕСТ',planId:plan?.id||'—',routeId:plan?.route_id||61373,routeName:'Проверка уведомления — заявка WB не принималась',carDt:new Date().toISOString(),driver:plan?.driver_label||'Тестовый водитель',vehicle:plan?.vehicle_label||'Тестовый автомобиль',trailer:plan?.trailer_label||null};
    const result=db.prepare('INSERT INTO acceptance_alerts(user_id,request_id,payload,created_at) VALUES(?,?,?,?)').run(userId,-randomBytes(6).readUIntBE(0,6),JSON.stringify(payload),new Date().toISOString());
    audit(actor.id,'test_alert_created',plan?.id||null,'Тест звука и окна для '+owner.name);return {id:Number(result.lastInsertRowid),recipient:owner.name};
  }
  function deleteBotEvent(id,actor){
    if(actor?.role!=='super_admin')fail(403,'Удалять записи может только администратор.');
    return transaction(()=>{const event=db.prepare('SELECT payload FROM bot_events WHERE id=?').get(id);if(!event)fail(404,'Запись не найдена.');const payload=JSON.parse(event.payload);db.prepare('DELETE FROM bot_events WHERE id=?').run(id);db.prepare('UPDATE bot_observations SET active=0 WHERE id=?').run(payload.id);audit(actor.id,'bot_event_deleted',null,'Запись '+id+', заявка WB '+payload.id+'; история попыток сохранена.');return {ok:true,requestId:payload.id};});
  }
  const acceptanceStore=createAcceptanceStore({db,transaction,botConfig,recordAcceptanceResult,audit,fail});
  return {...acceptanceStore,deleteBotEvent,createTestAlert,userAlerts,acknowledgeAlert,recordAcceptanceResult,getBotSnapshot,recordBotLog,getBotSettings,saveBotSettings,botConfig,stopBot,setBotRuntime,getBotStatus,recordBotCandidates};
}

