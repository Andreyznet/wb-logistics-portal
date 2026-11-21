import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {emitKeypressEvents} from 'node:readline';
import {openStore} from './store.js';
export function resetPassword(store,username,password){
 const user=store.users().find(u=>u.username===String(username||'').trim().toLowerCase());
 if(!user)throw new Error('Логин не найден в выбранной базе. Используйте administrator -- --list.');
 if(typeof password!=='string'||password.length<10||password.length>200)throw new Error('Пароль должен содержать от 10 до 200 символов.');
 // Local server operator recovery: preserve the exact account and role; normal
 // updateUser hashing, validation, transaction and session revocation still apply.
 store.updateUser(user.id,{name:user.name,username:user.username,role:user.role,password},{id:user.id,role:'super_admin'});
 return {username:user.username,name:user.name};
}
async function hiddenInput(prompt){
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Запустите команду в интерактивном PowerShell или терминале. Пароль через аргументы не принимается.');
 process.stdout.write(prompt);emitKeypressEvents(process.stdin);const wasRaw=Boolean(process.stdin.isRaw);process.stdin.setRawMode(true);process.stdin.resume();
 return new Promise((resolve,reject)=>{let value='';const finish=(error)=>{process.stdin.removeListener('keypress',key);process.stdin.removeListener('end',end);process.stdin.setRawMode(wasRaw);process.stdin.pause();process.stdout.write('\n');error?reject(error):resolve(value);};const end=()=>finish(new Error('Ввод отменён.'));const key=(text,event={})=>{if(event.ctrl&&event.name==='c')return finish(new Error('Ввод отменён.'));if(event.name==='return'||event.name==='enter')return finish();if(event.name==='backspace'){value=Array.from(value).slice(0,-1).join('');return;}if(!event.ctrl&&!event.meta&&text&&!text.includes('\u001b')&&value.length<200)value+=text;};process.stdin.on('keypress',key);process.stdin.once('end',end);});
}
export async function main(){
 const username=process.argv[2];if(!username||process.argv.length>3)throw new Error('Использование: npm.cmd run password-reset -- ЛОГИН. Новый пароль вводится скрыто в терминале.');
 const file=resolve(process.env.DATABASE_FILE||'./data/portal.sqlite');if(!existsSync(file))throw new Error('База не найдена: '+file+'. Укажите DATABASE_FILE в .env.');
 const store=openStore(file);try{const user=store.users().find(u=>u.username===username.trim().toLowerCase());if(!user)throw new Error('Логин не найден в базе '+file);console.log('База: '+file+'\nУчётная запись: '+user.username+' ('+user.name+')');const password=await hiddenInput('Новый пароль (10–200 символов, ввод скрыт): ');const confirm=await hiddenInput('Повторите пароль: ');if(password!==confirm)throw new Error('Пароли не совпадают. Ничего не изменено.');resetPassword(store,username,password);console.log('Пароль изменён. Войдите с логином '+user.username+'. Заявки и настройки сохранены.');}finally{store.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{await main();}catch(error){console.error(error.message);process.exitCode=1;}}
