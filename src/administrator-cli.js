import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {openStore} from './store.js';
const file=resolve(process.env.DATABASE_FILE||'./data/portal.sqlite');
const username=process.argv[2];
if(!existsSync(file)){console.error('База не найдена: '+file+'. Запустите команду из папки действующего портала.');process.exitCode=1;}
else{
 const store=openStore(file);
 try{
  if(username==='--list')console.log(JSON.stringify({database:file,users:store.users().map(u=>({id:u.id,username:u.username,name:u.name,role:u.role}))},null,2));
  else if(!username){console.error('Использование: npm.cmd run administrator -- ЛОГИН\nСписок пользователей: npm.cmd run administrator -- --list');process.exitCode=1;}
  else{
   const user=store.users().find(u=>u.username===username.trim().toLowerCase());if(!user)throw new Error('Пользователь с таким логином не найден.');
   store.db.exec('BEGIN IMMEDIATE');
   try{store.db.prepare("UPDATE users SET role='super_admin' WHERE id=?").run(user.id);store.db.prepare('INSERT INTO audit(user_id,action,request_id,detail,created_at) VALUES(?,?,NULL,?,?)').run(user.id,'administrator_recovered','Повышение через локальную команду сервера: '+user.username,new Date().toISOString());store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}
   console.log('Роль «Администратор» назначена: '+user.username+'. База: '+file+'. Войдите в портал заново.');
  }
 }catch(error){console.error(error.message);process.exitCode=1;}finally{store.close();}
}
