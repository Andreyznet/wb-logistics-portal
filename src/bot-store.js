import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const defaults = () => ({ revision:0, enabled:false, intervalSeconds:60, scheduleEnabled:false, days:[1,2,3,4,5], startTime:'08:00', endTime:'20:00', updatedAt:null });
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
    CREATE TABLE IF NOT EXISTS bot_logs(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bot_events(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const read=(name,fallback)=>{const r=db.prepare('SELECT value FROM settings WHERE key=?').get(name);return r?JSON.parse(r.value):fallback;};
  const write=(name,value)=>db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name,JSON.stringify(value));
  function encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return{iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};}
  function decrypt(value){if(!value)return '';const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));cipher.setAuthTag(Buffer.from(value.tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]).toString('utf8');}
  const requireAdmin=actor=>{if(actor?.role!=='admin')fail(403,'Настройки бота доступны только администратору.');};
  function getBotSettings(actor){requireAdmin(actor);const config=read('bot_config',defaults());const secret=read('bot_token',null);return {...config,timeZone,hasToken:Boolean(secret),tokenExpiresAt:secret?tokenExpiry(decrypt(secret)):null};}
  function saveBotSettings(input,actor){
    requireAdmin(actor);
    if(typeof input.enabled!=='boolean'||typeof input.scheduleEnabled!=='boolean')fail(400,'Укажите состояние бота и расписания.');
    if(!Number.isSafeInteger(input.intervalSeconds)||input.intervalSeconds<3||input.intervalSeconds>86400)fail(400,'Интервал опроса — целое число от 3 до 86400 секунд.');
    if(!Array.isArray(input.days)||input.days.some(day=>!Number.isInteger(day)||day<1||day>7)||input.days.length!==new Set(input.days).size||input.scheduleEnabled&&!input.days.length)fail(400,'Выберите дни работы бота.');
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.endTime)||input.scheduleEnabled&&input.startTime===input.endTime)fail(400,'Укажите корректное время начала и окончания. Для круглосуточной работы отключите расписание.');
    if(input.clearToken!==undefined&&typeof input.clearToken!=='boolean')fail(400,'Некорректная настройка токена.');
    let supplied='';
    if(input.token!==undefined){if(typeof input.token!=='string')fail(400,'Токен должен быть строкой.');supplied=input.token.trim().replace(/^Bearer\s+/i,'');if(supplied&&(supplied.length<10||supplied.length>16384||/\s/.test(supplied)))fail(400,'Проверьте токен: в нём не должно быть пробелов или переносов строк.');}
    if(supplied&&input.clearToken)fail(400,'Нельзя одновременно заменить и удалить токен.');
    return transaction(()=>{
      const current=read('bot_config',defaults());
      if(input.revision!==current.revision)fail(409,'Настройки изменены другим администратором. Обновите страницу.');
      const secret=input.clearToken?null:supplied?encrypt(supplied):read('bot_token',null);
      if(input.enabled&&!secret)fail(400,'Перед включением сохраните токен WB.');
      const exp=secret?tokenExpiry(decrypt(secret)):null;
      if(input.enabled&&exp&&Date.parse(exp)<=Date.now())fail(400,'Срок токена истёк. Введите новый токен.');
      write('bot_token',secret);
      write('bot_config',{revision:current.revision+1,enabled:input.enabled,intervalSeconds:input.intervalSeconds,scheduleEnabled:false,days:input.days,startTime:input.startTime,endTime:input.endTime,updatedAt:new Date().toISOString()});
      audit(actor.id,'bot_settings_updated',null,`Бот ${input.enabled?'включён':'выключен'}; опрос ${input.intervalSeconds} сек.; расписание ${input.scheduleEnabled?'включено':'выключено'}${supplied?'; токен заменён':input.clearToken?'; токен удалён':''}`);
      return getBotSettings(actor);
    });
  }
  function botConfig(){return {...read('bot_config',defaults()),token:decrypt(read('bot_token',null)),timeZone};}
  function stopBot(reason){const config=read('bot_config',defaults());if(config.enabled){write('bot_config',{...config,enabled:false,revision:config.revision+1,updatedAt:new Date().toISOString()});audit(null,'bot_stopped',null,reason);}}
  function setBotRuntime(runtime){const old=read('bot_runtime',{});const value={...old,...runtime};if(JSON.stringify(old)!==JSON.stringify(value))write('bot_runtime',value);return value;}
  function getBotStatus(actor){requireAdmin(actor);return {runtime:read('bot_runtime',{state:'stopped'}),logs:db.prepare('SELECT * FROM bot_logs ORDER BY id DESC LIMIT 100').all().map(row=>({...row,payload:JSON.parse(row.payload)})),events:db.prepare('SELECT id,kind,payload,created_at FROM bot_events ORDER BY id DESC LIMIT 30').all().map(row=>({...row,payload:JSON.parse(row.payload)}))};}
  function recordBotCandidates(candidates){return transaction(()=>{
    const old=new Map(db.prepare('SELECT * FROM bot_observations').all().map(row=>[row.id,row]));
    db.exec('UPDATE bot_observations SET active=0');
    let events=0;
    for(const row of candidates){const payload=JSON.stringify(row),hash=createHash('sha256').update(payload).digest('hex'),previous=old.get(row.id);if(!previous||!previous.active||previous.fingerprint!==hash){db.prepare('INSERT INTO bot_events(kind,payload,created_at) VALUES(?,?,?)').run(previous?.active?'candidate_updated':'candidate_found',payload,new Date().toISOString());recordBotLog('curl_preview',row);events++;}db.prepare('INSERT INTO bot_observations VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,active=1,payload=excluded.payload').run(row.id,hash,payload);}
    db.exec('DELETE FROM bot_events WHERE id NOT IN (SELECT id FROM bot_events ORDER BY id DESC LIMIT 1000)');return events;
  });}
  function recordBotLog(kind,payload){
    const at=new Date().toISOString();
    db.prepare('INSERT INTO bot_logs(kind,payload,created_at) VALUES(?,?,?)').run(kind,JSON.stringify(payload),at);
    db.exec('DELETE FROM bot_logs WHERE id NOT IN (SELECT id FROM bot_logs ORDER BY id DESC LIMIT 2000)');
    console.log(JSON.stringify({at,type:kind,...payload}));
  }
  return {recordBotLog,getBotSettings,saveBotSettings,botConfig,stopBot,setBotRuntime,getBotStatus,recordBotCandidates};
}

