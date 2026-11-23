import {createHash,randomBytes} from 'node:crypto';
import {apiIncident} from './api-monitor.js';
export function initMobile(store){store.db.exec(`CREATE TABLE IF NOT EXISTS mobile_devices(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),installation_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,registered_at TEXT NOT NULL,expires_at INTEGER NOT NULL,UNIQUE(user_id,installation_id)); CREATE TABLE IF NOT EXISTS mobile_alert_receipts(device_id INTEGER NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,alert_id INTEGER NOT NULL REFERENCES acceptance_alerts(id) ON DELETE CASCADE,acked_at TEXT NOT NULL,PRIMARY KEY(device_id,alert_id));`);}
const hash=value=>createHash('sha256').update(value).digest('hex');
export function connectMobile(store,user,installationId){
 if(typeof installationId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(installationId)){const error=new Error('Некорректное устройство.');error.status=400;throw error;}
 const token=randomBytes(32).toString('base64url'),now=new Date().toISOString();
 store.db.prepare('DELETE FROM mobile_devices WHERE installation_id=? AND user_id<>?').run(installationId,user.id);
 store.db.prepare('INSERT INTO mobile_devices(user_id,installation_id,token_hash,registered_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,installation_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at').run(user.id,installationId,hash(token),now,Date.now()+30*86400000);
 return {token,userId:user.id,cursor:store.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM bot_logs').get().id};
}
export function mobileDevice(store,authorization){
 const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization||'')?.[1];if(!token)return null;
 const row=store.db.prepare('SELECT d.*,u.name,u.role FROM mobile_devices d JOIN users u ON u.id=d.user_id WHERE token_hash=? AND expires_at>?').get(hash(token),Date.now());
 return row?{...row,user:{id:row.user_id,name:row.name,role:row.role}}:null;
}
export function mobileAlerts(store,user,device){
 return store.db.prepare('SELECT a.id,a.payload,a.created_at FROM acceptance_alerts a WHERE a.user_id=? AND (a.created_at>=? OR a.ack_at IS NULL) AND NOT EXISTS(SELECT 1 FROM mobile_alert_receipts r WHERE r.device_id=? AND r.alert_id=a.id) ORDER BY a.id LIMIT 30').all(user.id,device.registered_at,device.id).map(a=>({...a,payload:JSON.parse(a.payload)}));
}
export function ackMobile(store,user,device,id){
 if(!store.db.prepare('SELECT id FROM acceptance_alerts WHERE id=? AND user_id=?').get(id,user.id)){const error=new Error('Уведомление не найдено.');error.status=404;throw error;}
 store.db.prepare('INSERT OR IGNORE INTO mobile_alert_receipts VALUES(?,?,?)').run(device.id,id,new Date().toISOString());return {ok:true};
}
// Browser acknowledgement and each phone's acknowledgement are independent.
export function mobileSync(store,user,query,device=null){
 const admin=['admin','super_admin'].includes(user.role),runtime=store.getBotStatus({role:'admin'},true).runtime||{};
 const max=store.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM bot_logs').get().id;
 const since=query.since==null?max:Number(query.since);
 if(!Number.isSafeInteger(since)||since<0){const e=new Error('Некорректный курсор уведомлений.');e.status=400;throw e;}
 const kinds=['bot_enabled','bot_disabled','poll_failed','api_error','api_recovered'];
 const rows=store.db.prepare('SELECT id,kind,payload,created_at FROM bot_logs WHERE id>? AND kind IN ('+kinds.map(()=>'?').join(',')+') ORDER BY id LIMIT 100').all(since,...kinds);
 const events=rows.flatMap(row=>{const p=JSON.parse(row.payload);if(['api_error','api_recovered'].includes(row.kind)&&p.notify!==true)return [];return [{id:row.id,kind:row.kind,at:row.created_at,message:admin?p.message:row.kind==='bot_enabled'?'Бот запущен.':row.kind==='bot_disabled'?'Бот остановлен.':row.kind==='api_recovered'?'Связь с API восстановлена.':'В работе бота произошла ошибка. Сообщите менеджеру.'}];});
 const bot={enabled:store.botConfig().enabled,error:runtime.error?(admin?runtime.error:'Ошибка работы бота. Сообщите менеджеру.'):null,apiErrors:Object.values(runtime.apiIssues||{}).filter(apiIncident).length};
 const alerts=device?mobileAlerts(store,user,device):store.userAlerts(user),notification=store.notificationSettings(user.id);
 const revision=hash(JSON.stringify({bot,alerts:alerts.map(a=>a.id),notification}));
 return {user:{id:user.id,name:user.name,role:user.role},cursor:rows.length===100?rows.at(-1).id:max,hasMore:rows.length===100,revision,bot,events,alerts,notification};
}
export async function waitMobile(store,user,query,device,signal){
 const seconds=Number(query.wait||0);if(!Number.isInteger(seconds)||seconds<0||seconds>25){const e=new Error('Некорректное ожидание.');e.status=400;throw e;}
 const until=Date.now()+seconds*1000;
 while(!signal.aborted){
  const result=mobileSync(store,user,query,device);
  if(!seconds||!query.revision||result.revision!==query.revision||result.events.length||result.hasMore||Date.now()>=until)return result;
  await new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,200);signal.addEventListener('abort',done,{once:true});});
 }
 return null;
}
