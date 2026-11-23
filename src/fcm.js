import {readFileSync} from 'node:fs';
import {sign} from 'node:crypto';

export function initFcm(store){
 const columns=store.db.prepare('PRAGMA table_info(mobile_devices)').all();
 for(const [name,type]of [['push_token','TEXT'],['push_enabled','INTEGER NOT NULL DEFAULT 1']])if(!columns.some(c=>c.name===name))store.db.exec('ALTER TABLE mobile_devices ADD COLUMN '+name+' '+type);
 store.db.exec(`CREATE TABLE IF NOT EXISTS fcm_outbox(id INTEGER PRIMARY KEY,device_id INTEGER NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,event_key TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL,retry_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,sent_at INTEGER,UNIQUE(device_id,event_key)); CREATE INDEX IF NOT EXISTS fcm_pending ON fcm_outbox(sent_at,retry_at);`);
}
export function registerPush(store,device,input){
 if(typeof input.token!=='string'||input.token.length<20||input.token.length>4096||/\s/.test(input.token)||typeof input.enabled!=='boolean'){const e=new Error('Некорректный FCM-токен.');e.status=400;throw e;}
 store.db.prepare('UPDATE mobile_devices SET push_token=NULL WHERE push_token=? AND id<>?').run(input.token,device.id);
 store.db.prepare('UPDATE mobile_devices SET push_token=?,push_enabled=? WHERE id=?').run(input.token,input.enabled?1:0,device.id);
 // A phone connecting after an assignment still receives its unacknowledged queue.
 store.db.prepare("INSERT OR IGNORE INTO fcm_outbox(device_id,event_key,kind,created_at) SELECT ?, 'alert:'||a.id,'alert',? FROM acceptance_alerts a WHERE a.user_id=? AND (a.created_at>=? OR a.ack_at IS NULL) AND NOT EXISTS(SELECT 1 FROM mobile_alert_receipts r WHERE r.device_id=? AND r.alert_id=a.id)").run(device.id,Date.now(),device.user_id,device.registered_at,device.id);
 return {registered:true};
}
export function googleSender(file,projectId,fetchImpl=fetch){
 const c=JSON.parse(readFileSync(file,'utf8'));if(c.type!=='service_account'||typeof c.private_key!=='string'||typeof c.client_email!=='string')throw new Error('Invalid FCM service account');
 const project=projectId||c.project_id;if(!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project||''))throw new Error('Invalid FCM project');
 let access='',expires=0;
 return async function send(token,data){
  if(Date.now()>=expires){
   const now=Math.floor(Date.now()/1000),encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
   const unsigned=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:c.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600});
   const assertion=unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),c.private_key).toString('base64url');
   const response=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
   const body=await response.json();if(!response.ok||typeof body.access_token!=='string')throw new Error('FCM_AUTH_HTTP_'+response.status);
   access=body.access_token;expires=Date.now()+Math.max(0,Number(body.expires_in||3600)-60)*1000;
  }
  const response=await fetchImpl('https://fcm.googleapis.com/v1/projects/'+project+'/messages:send',{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},body:JSON.stringify({message:{token,data,android:{priority:'HIGH',ttl:'3600s'}}})});
  let body={};try{body=await response.json();}catch{}
  if(response.ok)return;
  if(response.status===401)expires=0;
  const code=body.error?.details?.find(d=>d['@type']==='type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
  const error=new Error('FCM_HTTP_'+response.status);error.unregistered=code==='UNREGISTERED';throw error;
 };
}
export class FcmDispatcher {
 constructor(store,{send=null,credentialsFile=process.env.GOOGLE_APPLICATION_CREDENTIALS,projectId=process.env.FCM_PROJECT_ID,clock=()=>Date.now()}={}){
  this.store=store;this.clock=clock;this.send=send;this.timer=null;this.busy=false;
  if(!send&&credentialsFile)try{this.send=googleSender(credentialsFile,projectId);}catch{console.error('FCM: не удалось прочитать серверные учётные данные. Push отключён.');}
  for(const [key,table]of [['fcm_log_cursor','bot_logs'],['fcm_alert_cursor','acceptance_alerts']])if(!store.db.prepare('SELECT value FROM settings WHERE key=?').get(key))store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(store.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM '+table).get().id));
 }
 get enabled(){return Boolean(this.send);}
 start(){if(!this.enabled){console.log('FCM: серверный ключ не настроен; доступна резервная связь Android.');return;}console.log('FCM: очередь push-доставки запущена.');this.timer=setInterval(()=>void this.tick(),1000);this.timer.unref();void this.tick();}
 stop(){clearInterval(this.timer);}
 scan(){
  const db=this.store.db,now=this.clock(),read=key=>JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key).value),write=(key,id)=>db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(id),key);
  db.exec('BEGIN IMMEDIATE');try{
   const alerts=db.prepare('SELECT id,user_id FROM acceptance_alerts WHERE id>? ORDER BY id LIMIT 200').all(read('fcm_alert_cursor'));
   const logs=db.prepare('SELECT id,kind,payload FROM bot_logs WHERE id>? ORDER BY id LIMIT 500').all(read('fcm_log_cursor'));
   const insert=db.prepare('INSERT OR IGNORE INTO fcm_outbox(device_id,event_key,kind,created_at) VALUES(?,?,?,?)');
   const devices=db.prepare('SELECT id,user_id FROM mobile_devices WHERE push_token IS NOT NULL AND push_enabled=1 AND expires_at>?').all(now);
   for(const a of alerts)for(const d of devices)if(d.user_id===a.user_id)insert.run(d.id,'alert:'+a.id,'alert',now);
   for(const log of logs){if(!['bot_enabled','bot_disabled','poll_failed','api_error','api_recovered'].includes(log.kind))continue;const p=JSON.parse(log.payload);if(['api_error','api_recovered'].includes(log.kind)&&p.notify!==true)continue;for(const d of devices)insert.run(d.id,'log:'+log.id,log.kind,now);}
   if(alerts.length)write('fcm_alert_cursor',alerts.at(-1).id);if(logs.length)write('fcm_log_cursor',logs.at(-1).id);
   db.prepare('DELETE FROM fcm_outbox WHERE created_at<?').run(now-86400000);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 async tick(){
  if(!this.enabled||this.busy)return;this.busy=true;
  try{
   this.scan();const db=this.store.db;
   const jobs=db.prepare('SELECT o.*,d.push_token FROM fcm_outbox o JOIN mobile_devices d ON d.id=o.device_id WHERE o.sent_at IS NULL AND o.retry_at<=? AND d.push_enabled=1 AND d.push_token IS NOT NULL AND d.expires_at>? ORDER BY o.id LIMIT 20').all(this.clock(),this.clock());
   for(const job of jobs)try{
    await this.send(job.push_token,{event:job.event_key,kind:job.kind});db.prepare('UPDATE fcm_outbox SET sent_at=? WHERE id=?').run(this.clock(),job.id);
   }catch(error){
    if(error.unregistered){db.prepare('UPDATE mobile_devices SET push_token=NULL WHERE id=? AND push_token=?').run(job.device_id,job.push_token);db.prepare('UPDATE fcm_outbox SET sent_at=? WHERE id=?').run(this.clock(),job.id);}
    else db.prepare('UPDATE fcm_outbox SET attempts=attempts+1,retry_at=? WHERE id=?').run(this.clock()+Math.min(3600000,1000*2**Math.min(job.attempts+1,12)),job.id);
    // Never log a device registration token, OAuth credential or response body.
    console.error('FCM: доставка отложена',job.id,error.unregistered?'UNREGISTERED':/^FCM_(AUTH_)?HTTP_\d{3}$/.test(error.message)?error.message:'SEND_FAILED');
   }
  }catch{console.error('FCM: ошибка очереди доставки.');}finally{this.busy=false;}
 }
}
