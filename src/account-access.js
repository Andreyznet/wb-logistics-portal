import {requirePermission} from './permissions.js';
import {fail} from './store.js';
export function listDevices(store,actor){
 if(actor?.role!=='super_admin')fail(403,'Устройства доступны только администратору.');
 return store.db.prepare(`SELECT d.id,d.user_id,u.name,u.role,u.blocked,d.device_name,d.app_version,d.registered_at,d.last_seen_at,d.last_ui_at,d.foreground,d.revoked_at,d.expires_at,CASE WHEN d.push_token IS NOT NULL THEN 1 ELSE 0 END AS has_push,d.push_enabled FROM mobile_devices d JOIN users u ON u.id=d.user_id ORDER BY d.last_seen_at DESC,d.id DESC`).all();
}
export function blockAccount(store,id,blocked,actor){
 requirePermission(store,actor,'users.block');
 if(typeof blocked!=='boolean')fail(400,'Укажите состояние блокировки.');
 const db=store.db;db.exec('BEGIN IMMEDIATE');try{
  const target=db.prepare('SELECT id,role,name,blocked FROM users WHERE id=?').get(id);
  if(!target)fail(404,'Пользователь не найден.');
  if(target.role==='super_admin'||blocked&&target.id===actor.id)fail(403,'Нельзя заблокировать администратора или собственную учётную запись.');
  if(Boolean(target.blocked)!==blocked){
   const at=new Date().toISOString();db.prepare('UPDATE users SET blocked=? WHERE id=?').run(blocked?1:0,id);
   if(blocked){
    // The credential fingerprint prevents a delayed push from logging out a new session.
    db.prepare("INSERT OR IGNORE INTO fcm_outbox(device_id,event_key,kind,created_at) SELECT id,'revoke:'||token_hash,'access_revoked',? FROM mobile_devices WHERE user_id=? AND push_token IS NOT NULL").run(Date.now(),id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    db.prepare('UPDATE mobile_devices SET expires_at=0,revoked_at=?,foreground=0 WHERE user_id=?').run(at,id);
   }
   db.prepare('INSERT INTO audit(user_id,action,detail,created_at) VALUES(?,?,?,?)').run(actor.id,blocked?'user_blocked':'user_unblocked',target.name,at);
  }
  db.exec('COMMIT');return {ok:true,blocked};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
