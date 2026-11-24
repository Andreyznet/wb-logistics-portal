import {notificationSounds} from './notification-sounds.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { createBotStore } from './bot-store.js';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new AppError(status, message); };
export const hashSession = token => createHash('sha256').update(token).digest('hex');
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordMatches(password, hash) {
  const [salt, key] = hash.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(key, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function businessDate(timeZone = 'Asia/Yekaterinburg') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const clean = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const integer = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

export function openStore(file, { timeZone = 'Asia/Yekaterinburg' } = {}) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('super_admin','admin','logist')), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS catalog(kind TEXT NOT NULL, id INTEGER NOT NULL, label TEXT NOT NULL, payload TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY AUTOINCREMENT, route_id INTEGER NOT NULL, service_date TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 1, driver_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL, trailer_id INTEGER, driver_label TEXT NOT NULL, vehicle_label TEXT NOT NULL, trailer_label TEXT, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('waiting','paused','archived')), version INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS requests_date_status ON requests(service_date,status);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, request_id INTEGER, detail TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  if(!db.prepare('PRAGMA table_info(requests)').all().some(c=>c.name==='observe_only'))db.exec('ALTER TABLE requests ADD COLUMN observe_only INTEGER NOT NULL DEFAULT 0 CHECK(observe_only IN (0,1))');
  const userSchema=db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get().sql;
  if(!userSchema.includes("'super_admin'")){
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
    try{db.exec("CREATE TABLE users_roles(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('super_admin','admin','logist')),created_at TEXT NOT NULL); INSERT INTO users_roles SELECT * FROM users; UPDATE users_roles SET role='super_admin' WHERE id=(SELECT min(id) FROM users_roles WHERE role='admin'); DROP TABLE users; ALTER TABLE users_roles RENAME TO users; COMMIT;");}catch(e){db.exec('ROLLBACK');throw e;}finally{db.exec('PRAGMA foreign_keys=ON');}
  }
  if(!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='blocked'))db.exec('ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE TABLE IF NOT EXISTS user_avatars(user_id INTEGER PRIMARY KEY REFERENCES users(id),preset TEXT,image BLOB,mime TEXT,revision TEXT NOT NULL)');
  db.exec("CREATE TABLE IF NOT EXISTS user_notification_settings(user_id INTEGER PRIMARY KEY REFERENCES users(id),sound_id TEXT NOT NULL,volume INTEGER NOT NULL)");
  const notificationSettings=id=>{const saved=db.prepare('SELECT sound_id,volume FROM user_notification_settings WHERE user_id=?').get(id);return {soundId:saved?.sound_id||'digital-alarm',volume:saved?.volume??80};};
  function saveNotificationSettings(input,actor){if(!actor?.id)fail(401,'Войдите в аккаунт.');if(!input||!notificationSounds.some(s=>s.id===input.soundId)||!Number.isInteger(input.volume)||input.volume<10||input.volume>100)fail(400,'Выберите звук и громкость от 10 до 100%.');db.prepare('INSERT INTO user_notification_settings VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET sound_id=excluded.sound_id,volume=excluded.volume').run(actor.id,input.soundId,input.volume);return {settings:notificationSettings(actor.id)};}
  const defaultAvatar=id=>'/avatars/'+['cat','frog','robot','bear','owl'][(id-1)%5]+'.svg';
  const avatarUrl=id=>{const value=db.prepare('SELECT preset,revision FROM user_avatars WHERE user_id=?').get(id);return value?value.preset?'/avatars/'+value.preset+'.svg':'/api/users/'+id+'/avatar?v='+value.revision:defaultAvatar(id);};
  const now = () => new Date().toISOString();
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const publicUser = row => row ? { id: row.id, username: row.username, name: row.name, role: row.role, blocked:Boolean(row.blocked), notificationSettings:notificationSettings(row.id), avatar:avatarUrl(row.id) } : null;
  function audit(userId, action, requestId = null, detail = '') {
    db.prepare('INSERT INTO audit(user_id,action,request_id,detail,created_at) VALUES(?,?,?,?,?)').run(userId, action, requestId, detail, now());
  }
  function saveAvatar(input,actor){
    if(!actor?.id||!db.prepare('SELECT id FROM users WHERE id=?').get(actor.id))fail(401,'Войдите в аккаунт.');
    let preset=null,image=null,mime=null;
    if(input.preset!==undefined){if(!['cat','frog','robot','bear','owl'].includes(input.preset))fail(400,'Выберите стандартный аватар.');preset=input.preset;}
    else{
      const match=typeof input.image==='string'&&/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(input.image);if(!match||match[2].length>350000)fail(400,'Нужна картинка PNG, JPEG или WebP до 256 КБ.');
      mime=match[1];image=Buffer.from(match[2],'base64');
      const valid=mime==='image/png'?image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/jpeg'?image[0]===255&&image[1]===216&&image[2]===255:image.toString('ascii',0,4)==='RIFF'&&image.toString('ascii',8,12)==='WEBP';
      if(!valid||image.length>262144)fail(400,'Некорректный формат картинки.');
    }
    return transaction(()=>{db.prepare('INSERT INTO user_avatars VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET preset=excluded.preset,image=excluded.image,mime=excluded.mime,revision=excluded.revision').run(actor.id,preset,image,mime,randomBytes(8).toString('hex'));audit(actor.id,'avatar_updated',null,'Аватар обновлён');return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(actor.id));});
  }
  function getAvatar(id){const row=db.prepare('SELECT image,mime FROM user_avatars WHERE user_id=?').get(id);if(!row?.image)fail(404,'Картинка не найдена.');return row;}
  function userCount() { return db.prepare('SELECT count(*) AS n FROM users').get().n; }
  function addUser(input, actor = null, setup = false) {
    const username = clean(input.username, 64).toLowerCase();
    const name = clean(input.name, 100);
    const password = input.password;
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) fail(400, 'Логин: от 3 до 64 латинских букв, цифр, точек или дефисов.');
    if (!name) fail(400, 'Укажите имя сотрудника.');
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) fail(400, 'Пароль должен содержать от 10 до 200 символов.');
    if (!setup && !['admin','super_admin'].includes(actor?.role)) fail(403, 'Действие доступно менеджеру или администратору.');
    const hash = passwordHash(password);
    return transaction(() => {
      if (setup && userCount()) fail(409, 'Первоначальная настройка уже выполнена.');
      if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) fail(409, 'Такой логин уже существует.');
      const role = setup ? 'super_admin' : input.role||'logist';
      if(!['super_admin','admin','logist'].includes(role))fail(400,'Неизвестная роль.');
      if(!setup&&role==='super_admin'&&actor.role!=='super_admin')fail(403,'Только администратор может назначить администратора.');
      const result = db.prepare('INSERT INTO users(username,name,password_hash,role,created_at) VALUES(?,?,?,?,?)').run(username, name, hash, role, now());
      const user = publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid));
      audit(actor?.id ?? user.id, 'user_created', null, name);
      return user;
    });
  }
  function updateUser(id,input,actor){
    if(!['super_admin','admin'].includes(actor?.role))fail(403,'Доступно только менеджеру или администратору.');
    return transaction(()=>{
      const old=db.prepare('SELECT * FROM users WHERE id=?').get(id);if(!old)fail(404,'Пользователь не найден.');
      const role=input.role??old.role,name=clean(input.name??old.name,100),username=clean(input.username??old.username,64).toLowerCase();
      if(!['super_admin','admin','logist'].includes(role))fail(400,'Неизвестная роль.');
      if(actor.role!=='super_admin'&&(old.role==='super_admin'||role==='super_admin'))fail(403,'Только администратор может менять администратора.');
      if(old.role==='super_admin'&&role!=='super_admin'&&db.prepare("SELECT count(*) AS n FROM users WHERE role='super_admin'").get().n<=1)fail(409,'Нельзя понизить последнего администратора.');
      if(!name||!/^[a-z0-9._-]{3,64}$/.test(username))fail(400,'Проверьте имя и логин.');
      if(db.prepare('SELECT id FROM users WHERE username=? AND id<>?').get(username,id))fail(409,'Такой логин уже существует.');
      let hash=old.password_hash;if(input.password){if(typeof input.password!=='string'||input.password.length<10||input.password.length>200)fail(400,'Пароль должен содержать от 10 до 200 символов.');hash=passwordHash(input.password);}
      db.prepare('UPDATE users SET name=?,username=?,role=?,password_hash=? WHERE id=?').run(name,username,role,hash,id);
      if(hash!==old.password_hash)db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      audit(actor.id,'user_updated',null,name+'; роль: '+role);return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
    });
  }
  // Use a real password hash for unknown usernames as well, to avoid an obvious timing distinction.
  const dummyHash = passwordHash(randomBytes(24).toString('hex'));
  function login(username, password) {
    const row = db.prepare('SELECT * FROM users WHERE username=?').get(clean(username, 64).toLowerCase());
    const good = passwordMatches(typeof password === 'string' ? password.slice(0, 200) : '', row?.password_hash || dummyHash);
    if (!row || !good) fail(401, 'Неверный логин или пароль.');
    if(row.blocked)fail(403,'Учётная запись заблокирована. Обратитесь к менеджеру или администратору.');
    return publicUser(row);
  }
  function createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashSession(token), userId, Date.now() + 86400000);
    return token;
  }
  function session(token) {
    if (!token || token.length > 200) return null;
    return publicUser(db.prepare('SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.blocked=0').get(hashSession(token), Date.now()));
  }
  function importDirectory(input, actorId = null) {
    const source = input?.transport ?? input?.data;
    if (!source || ['drivers', 'vehicles', 'trailers'].some(k => !Array.isArray(source[k]))) fail(400, 'Нужен directory.json с массивами drivers, vehicles и trailers внутри transport (или data).');
    const kinds = { drivers: 'driver', vehicles: 'vehicle', trailers: 'trailer' };
    const rows = [];
    for (const [collection, kind] of Object.entries(kinds)) {
      if (source[collection].length > 20000) fail(400, 'Слишком большой справочник.');
      const ids = new Set();
      for (const raw of source[collection]) {
        const id = integer(raw?.id);
        if (!id || ids.has(id)) fail(400, `Некорректный или повторный ID в ${collection}.`);
        ids.add(id);
        const name = clean(raw.name, 180);
        const plate = clean(raw.number_plate, 40);
        const label = kind === 'driver' ? name || `Водитель ID ${id}` : plate ? `${plate}${name && name !== plate ? ` · ${name}` : ''}` : name || `${kind === 'vehicle' ? 'Автомобиль' : 'Прицеп'} ID ${id}`;
        rows.push({ kind, id, label, payload: JSON.stringify({ id, name, number_plate: plate, vehicle_type_id: raw.vehicle_type_id ?? null }) });
      }
    }
    const vehicleIds = new Set(rows.filter(r => r.kind === 'vehicle').map(r => r.id));
    if (rows.some(r => r.kind === 'trailer' && vehicleIds.has(r.id))) fail(400, 'Один ID указан одновременно для автомобиля и прицепа.');
    return transaction(() => {
      db.exec("UPDATE catalog SET active=0 WHERE kind IN ('driver','vehicle','trailer')");
      const insert = db.prepare('INSERT INTO catalog(kind,id,label,payload,active) VALUES(?,?,?,?,1) ON CONFLICT(kind,id) DO UPDATE SET label=excluded.label,payload=excluded.payload,active=1');
      for (const row of rows) insert.run(row.kind, row.id, row.label, row.payload);
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('directory_imported_at', now());
      for(const row of rows)db.prepare('UPDATE catalog SET search_text=? WHERE kind=? AND id=?').run(normalizeSearch(row.id+' '+row.label),row.kind,row.id);
      audit(actorId, 'directory_imported', null, `Водителей: ${source.drivers.length}, авто: ${source.vehicles.length}, прицепов: ${source.trailers.length}`);
      return { drivers: source.drivers.length, vehicles: source.vehicles.length, trailers: source.trailers.length };
    });
  }
  const normalizeSearch=value=>String(value||'').toLocaleLowerCase('ru').replaceAll('ё','е');
  if(!db.prepare('PRAGMA table_info(catalog)').all().some(c=>c.name==='search_text')){db.exec("ALTER TABLE catalog ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");for(const row of db.prepare('SELECT kind,id,label FROM catalog').all())db.prepare('UPDATE catalog SET search_text=? WHERE kind=? AND id=?').run(normalizeSearch(row.id+' '+row.label),row.kind,row.id);}
  function cacheCatalogRows(kind,rows,{replace=false}={}){
    if(!['route','driver','vehicle','trailer'].includes(kind)||!Array.isArray(rows))fail(400,'Некорректный справочник.');
    const prepared=rows.map(row=>{const id=integer(row.id);if(!id)fail(502,'WB вернул некорректный ID.');const name=clean(row.name,kind==='route'?500:180),plate=clean(row.number_plate,40),label=kind==='route'?name:kind==='driver'?name||'Водитель ID '+id:plate?(plate+(name&&name!==plate?' · '+name:'')):name||'ТС ID '+id;return {id,label,data:{id,name,number_plate:plate},search:normalizeSearch(id+' '+label)};});
    transaction(()=>{if(replace)db.prepare('UPDATE catalog SET active=0 WHERE kind=?').run(kind);for(const row of prepared)db.prepare('INSERT INTO catalog(kind,id,label,payload,active,search_text) VALUES(?,?,?,?,1,?) ON CONFLICT(kind,id) DO UPDATE SET label=excluded.label,payload=excluded.payload,active=1,search_text=excluded.search_text').run(kind,row.id,row.label,JSON.stringify(row.data),row.search);});
    return prepared.map(row=>({...row.data,label:row.label}));
  }
  function catalogSummary(){const counts={drivers:0,vehicles:0,trailers:0},map={driver:'drivers',vehicle:'vehicles',trailer:'trailers'};for(const row of db.prepare('SELECT kind,count(*) AS n FROM catalog WHERE active=1 GROUP BY kind').all()){if(map[row.kind])counts[map[row.kind]]=row.n;};return {drivers:[],vehicles:[],trailers:[],counts,importedAt:db.prepare("SELECT value FROM settings WHERE key='directory_imported_at'").get()?.value??null};}
  function catalogPage(kind,query='',offset=0,limit=30){
    if(!['route','driver','vehicle','trailer'].includes(kind)||!Number.isSafeInteger(offset)||offset<0)fail(400,'Некорректная страница справочника.');
    const pattern='%'+normalizeSearch(query).replaceAll('!','!!').replaceAll('%','!%').replaceAll('_','!_')+'%';
    const rows=db.prepare("SELECT * FROM catalog WHERE active=1 AND kind=? AND search_text LIKE ? ESCAPE '!' ORDER BY label COLLATE NOCASE,id LIMIT ? OFFSET ?").all(kind,pattern,limit+1,offset);return {data:rows.slice(0,limit).map(row=>({...JSON.parse(row.payload),label:row.label})),hasMore:rows.length>limit};
  }
  function catalog() {
    const result = { drivers: [], vehicles: [], trailers: [], importedAt: db.prepare("SELECT value FROM settings WHERE key='directory_imported_at'").get()?.value ?? null };
    const names = { driver: 'drivers', vehicle: 'vehicles', trailer: 'trailers' };
    for (const row of db.prepare('SELECT * FROM catalog WHERE active=1 ORDER BY label COLLATE NOCASE').all()) {
      if(names[row.kind])result[names[row.kind]].push({ ...JSON.parse(row.payload), label: row.label });
    }
    return result;
  }
  function entry(kind, id) {
    const row = db.prepare('SELECT label FROM catalog WHERE kind=? AND id=? AND active=1').get(kind, id);
    if (!row) fail(400, `Выбранный ${kind === 'driver' ? 'водитель' : kind === 'vehicle' ? 'автомобиль' : 'прицеп'} отсутствует в актуальном справочнике.`);
    return row.label;
  }
  function validateRequest(input, old) {
    const observeOnly=input.observeOnly??Boolean(old?.observe_only);
    if(typeof observeOnly!=='boolean')fail(400,'Укажите корректный режим «Не брать в работу».');
    const routeId = integer(input.routeId);
    const date = input.serviceDate;
    const priority = integer(input.priority ?? 1);
    const driverId = integer(input.driverId), vehicleId = integer(input.vehicleId);
    const trailerId = input.trailerId == null || input.trailerId === '' ? null : integer(input.trailerId);
    if (!routeId || routeId > 2147483647) fail(400, 'Укажите корректный номер маршрута.');
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail(400, 'Укажите корректную дату подачи.');
    if (date < businessDate(timeZone) && date !== old?.service_date) fail(400, 'Дата подачи не может быть в прошлом.');
    if (!priority || priority > 99) fail(400, 'Приоритет должен быть от 1 до 99.');
    if (!driverId || !vehicleId || input.trailerId && !trailerId) fail(400, 'Выберите водителя, автомобиль и корректный прицеп.');
    return { observeOnly,routeId, date, priority, driverId, vehicleId, trailerId,
      driverLabel: entry('driver', driverId), vehicleLabel: entry('vehicle', vehicleId),
      trailerLabel: trailerId ? entry('trailer', trailerId) : null, note: clean(input.note, 1000) };
  }
  function checkBusy(value, excludeId = 0) {
    if(value.observeOnly)return;
    const conflict = db.prepare(`SELECT id,driver_id,vehicle_id,trailer_id FROM requests WHERE status='waiting' AND observe_only=0 AND service_date=? AND id<>? AND (driver_id=? OR vehicle_id=? OR (? IS NOT NULL AND trailer_id=?)) LIMIT 1`).get(value.date, excludeId, value.driverId, value.vehicleId, value.trailerId, value.trailerId);
    if (conflict) {
      const resource = conflict.driver_id === value.driverId ? 'Водитель' : conflict.vehicle_id === value.vehicleId ? 'Автомобиль' : 'Прицеп';
      fail(409, `${resource} уже запланирован на эту дату в заявке №${conflict.id}.`);
    }
  }
  function getRequest(id) { return db.prepare('SELECT * FROM requests WHERE id=?').get(id); }
  function saveRequest(input, actor, id = null) {
    return transaction(() => {
      const old = id ? getRequest(id) : null;
      if (id && !old) fail(404, 'Заявка не найдена.');
      if (old && db.prepare("SELECT id FROM acceptance_attempts WHERE plan_id=? AND state='success'").get(id)) fail(409, 'Обработанную заявку нельзя редактировать.');
      if(old&&db.prepare("SELECT id FROM acceptance_attempts WHERE plan_id=? AND state IN ('pending','uncertain')").get(id))fail(409,'Результат принятия ещё проверяется. Дождитесь подтверждения перед редактированием.');
      if (old?.status === 'archived') fail(409, 'Заявка в архиве.');
      if (old && Number(input.version) !== old.version) fail(409, 'Заявка уже изменена другим логистом. Обновите список.');
      const v = validateRequest(input, old);
      if (!old || old.status === 'waiting') checkBusy(v, id || 0);
      const at = now();
      if (old) {
        db.prepare('UPDATE requests SET observe_only=?,route_id=?,service_date=?,priority=?,driver_id=?,vehicle_id=?,trailer_id=?,driver_label=?,vehicle_label=?,trailer_label=?,note=?,version=version+1,updated_at=? WHERE id=?').run(Number(v.observeOnly),v.routeId,v.date,v.priority,v.driverId,v.vehicleId,v.trailerId,v.driverLabel,v.vehicleLabel,v.trailerLabel,v.note,at,id);
      } else {
        id = Number(db.prepare("INSERT INTO requests(observe_only,route_id,service_date,priority,driver_id,vehicle_id,trailer_id,driver_label,vehicle_label,trailer_label,note,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'waiting',?,?,?)").run(Number(v.observeOnly),v.routeId,v.date,v.priority,v.driverId,v.vehicleId,v.trailerId,v.driverLabel,v.vehicleLabel,v.trailerLabel,v.note,actor.id,at,at).lastInsertRowid);
      }
      audit(actor.id, old ? 'request_updated' : 'request_created', id, `Маршрут ${v.routeId}, ${v.date}`);
      return getRequest(id);
    });
  }
  function changeStatus(id, status, version, actor) {
    if (!['waiting','paused','archived'].includes(status)) fail(400, 'Некорректный статус.');
    return transaction(() => {
      const row = getRequest(id);
      if (!row) fail(404, 'Заявка не найдена.');
      if (row.version !== Number(version)) fail(409, 'Заявка уже изменена другим логистом. Обновите список.');
      if (row.status === 'archived') fail(409, 'Заявка уже в архиве.');
      if (status !== 'archived' && db.prepare("SELECT id FROM acceptance_attempts WHERE plan_id=? AND state='success'").get(id)) fail(409, 'Обработанную заявку можно только перенести в архив.');
      if (status === 'waiting') {
        const v = validateRequest({ routeId: row.route_id, serviceDate: row.service_date, priority: row.priority, driverId: row.driver_id, vehicleId: row.vehicle_id, trailerId: row.trailer_id }, row);
        checkBusy(v, id);
      }
      db.prepare('UPDATE requests SET status=?,version=version+1,updated_at=? WHERE id=?').run(status,now(),id);
      audit(actor.id, `request_${status}`,id,`Маршрут ${row.route_id}`);
      return getRequest(id);
    });
  }
  db.exec('CREATE TABLE IF NOT EXISTS request_watchers(request_id INTEGER NOT NULL REFERENCES requests(id),user_id INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,PRIMARY KEY(request_id,user_id))');
  function watchRequest(id,enabled,actor){
    if(!actor?.id)fail(401,'Войдите в аккаунт.');if(!Number.isSafeInteger(id)||id<1||typeof enabled!=='boolean')fail(400,'Некорректная подписка.');
    return transaction(()=>{const plan=db.prepare('SELECT * FROM requests WHERE id=?').get(id);if(!plan)fail(404,'Заявка не найдена.');
      if(plan.created_by===actor.id)fail(400,'Автор уже получает уведомления по своей заявке.');
      if(enabled&&(plan.status==='archived'||db.prepare("SELECT id FROM acceptance_attempts WHERE plan_id=? AND state='success'").get(id)))fail(409,'Можно подписаться только на ещё не принятую активную заявку.');
      if(enabled)db.prepare('INSERT OR IGNORE INTO request_watchers VALUES(?,?,?)').run(id,actor.id,now());else db.prepare('DELETE FROM request_watchers WHERE request_id=? AND user_id=?').run(id,actor.id);
      return {watching:enabled};
    });
  }
  const botStore=createBotStore({db,file,timeZone,audit,transaction,fail});
  return { notificationSettings,saveNotificationSettings,...botStore, db, timeZone, userCount, addUser, updateUser, saveAvatar, getAvatar, login, createSession, session, importDirectory, catalog, catalogSummary, catalogPage, cacheCatalogRows, saveRequest, changeStatus, watchRequest,
    logout: token => db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashSession(token || '')),
    users: () => db.prepare('SELECT id,username,name,role,created_at,blocked FROM users ORDER BY name').all().map(user=>({...user,avatar:avatarUrl(user.id)})),
    requests: (actor=null) => db.prepare("SELECT r.*,(SELECT label FROM catalog c WHERE c.kind='route' AND c.id=r.route_id) AS route_name,u.name AS created_by_name,EXISTS(SELECT 1 FROM request_watchers w WHERE w.request_id=r.id AND w.user_id=?) AS watching,(SELECT a.id FROM acceptance_attempts a WHERE a.plan_id=r.id AND a.state='success' ORDER BY a.updated_at DESC LIMIT 1) AS accepted_wb_id FROM requests r JOIN users u ON r.created_by=u.id ORDER BY r.service_date,r.priority,r.id").all(actor?.id||0),
    activity: () => db.prepare('SELECT a.*,u.name AS actor FROM audit a LEFT JOIN users u ON a.user_id=u.id ORDER BY a.id DESC LIMIT 200').all(),
    close: () => db.close(),
  };
}
