import {fail} from './store.js';
import {createHash} from 'node:crypto';

export const permissionDefinitions=[
 ['dashboard','Обзор','Вкладки'],['requests','Заявки логистов','Вкладки'],['found','Найденные заявки','Вкладки'],['catalog','Справочники','Вкладки'],['users','Команда','Вкладки'],['knowledge','База знаний','Вкладки'],['bot','Настройки бота','Вкладки'],['activity','История изменений','Вкладки'],['logs','Журнал мониторинга','Вкладки'],['download','Скачивание Android-приложения','Вкладки'],
 ['requests.create','Создавать заявки','Действия','requests'],['requests.edit','Редактировать заявки','Действия','requests'],['requests.status','Включать, приостанавливать и архивировать заявки','Действия','requests'],['requests.watch','Следить за чужими заявками','Действия','requests'],['users.manage','Создавать пользователей и менять их данные и роли','Действия','users'],['bot.manage','Изменять настройки, запускать и останавливать бота','Действия','bot'],['catalog.manage','Обновлять и импортировать справочники','Действия','catalog'],['found.details','Просматривать cURL и ответы API','Действия','found'],['found.delete','Удалять найденные записи','Действия','found']
].map(([key,label,group,parent])=>({key,label,group,...(parent?{parent}:{})}));
const roles=['super_admin','admin','logist'],keys=permissionDefinitions.map(d=>d.key),common=['dashboard','requests','found','catalog','users','knowledge','requests.create','requests.edit','requests.status','requests.watch'];
export const defaultPermissions=Object.fromEntries(roles.map(role=>[role,Object.fromEntries(keys.map(key=>[key,role==='super_admin'||common.includes(key)||role==='admin'&&['bot','bot.manage','users.manage','catalog.manage'].includes(key)]))]));
function snapshot(store){const value=store.db.prepare("SELECT value FROM settings WHERE key='role_permissions'").get()?.value||'';return {value,revision:createHash('sha256').update(value).digest('hex')};}
export function permissionMatrix(store){
 const {value,revision}=snapshot(store),saved=value?JSON.parse(value):{};
 const matrix=Object.fromEntries(roles.map(role=>[role,{...defaultPermissions[role],...saved[role]}]));
 matrix.super_admin={...defaultPermissions.super_admin};return {matrix,revision,definitions:permissionDefinitions,defaults:defaultPermissions};
}
export function permissionsFor(store,user){return user?permissionMatrix(store).matrix[user.role]||{}:{};}
export function allowed(store,user,key){const p=permissionsFor(store,user),parent=permissionDefinitions.find(d=>d.key===key)?.parent;return p[key]===true&&(!parent||p[parent]===true);}
export function requirePermission(store,user,key){if(!allowed(store,user,key))fail(403,'Недостаточно прав. Обратитесь к администратору.');}
export function savePermissions(store,input,actor){
 if(actor?.role!=='super_admin')fail(403,'Права может менять только администратор.');
 if(!input||!input.matrix||Object.keys(input.matrix).length!==roles.length)fail(400,'Передайте права для всех трёх ролей.');
 for(const role of roles){const row=input.matrix[role];if(!row||Object.keys(row).length!==keys.length||keys.some(k=>typeof row[k]!=='boolean'))fail(400,'Некорректный набор прав.');if(role==='super_admin'&&keys.some(k=>!row[k]))fail(400,'Администратор сохраняет полный доступ.');for(const d of permissionDefinitions)if(d.parent&&row[d.key]&&!row[d.parent])fail(400,'Для действия «'+d.label+'» включите соответствующую вкладку.');}
 store.db.exec('BEGIN IMMEDIATE');try{
  if(input.revision!==snapshot(store).revision)fail(409,'Права уже изменены. Обновите страницу перед сохранением.');
  store.db.prepare("INSERT INTO settings(key,value) VALUES('role_permissions',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(input.matrix));
  store.db.prepare('INSERT INTO audit(user_id,action,detail,created_at) VALUES(?,?,?,?)').run(actor.id,'permissions_updated','Изменены права ролей',new Date().toISOString());
  store.db.exec('COMMIT');return permissionMatrix(store);
 }catch(e){store.db.exec('ROLLBACK');throw e;}
}
// Store methods retain their role hierarchy checks. Explicitly granted operations
// may use the manager ceiling; only diagnostic methods receive the diagnostic role.
export const managerActor=user=>user.role==='super_admin'?user:{...user,role:'admin'};
export const diagnosticActor=user=>({...user,role:'super_admin'});
