import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openStore} from '../src/store.js';
const input=(username,role)=>({username,name:username,password:'roles-password-123',role});
test('three roles, protected super admins, editing and live session role changes',()=>{
 const store=openStore(':memory:');try{
 const root=store.addUser(input('root'),null,true);assert.equal(root.role,'super_admin');
 const admin=store.addUser(input('admin','admin'),root);const logist=store.addUser(input('logist','logist'),admin);
 assert.throws(()=>store.addUser(input('illegal','super_admin'),admin));assert.throws(()=>store.addUser(input('illegal','admin'),logist));
 assert.throws(()=>store.updateUser(root.id,{name:'Changed'},admin));assert.throws(()=>store.updateUser(logist.id,{role:'super_admin'},admin));assert.throws(()=>store.updateUser(root.id,{role:'logist'},root));assert.throws(()=>store.updateUser(admin.id,{role:'admin'},logist));
 const session=store.createSession(logist.id);store.updateUser(logist.id,{name:'Updated',role:'admin'},admin);assert.equal(store.session(session).role,'admin');
 store.addUser(input('secondroot','super_admin'),root);store.updateUser(root.id,{role:'admin'},root);assert.equal(store.login('root','roles-password-123').role,'admin');
 store.recordBotCandidates([{id:999,routeId:61373,curl:'secret curl'}],{response:{private:'WB response'}});
 const status=store.getBotStatus(admin);assert.deepEqual(status.logs,[]);assert.deepEqual(status.events,[]);assert.equal(JSON.stringify(status).includes('secret curl'),false);assert.throws(()=>store.getBotSnapshot(1,admin));assert.throws(()=>store.getBotSettings(logist));
 }finally{store.close();}
});
test('legacy users migrate without losing sessions and only the first admin is promoted',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'wb-roles-'));const file=join(folder,'portal.sqlite');let store=openStore(file);
 try{const first=store.addUser(input('first'),null,true);store.addUser(input('second','admin'),first);const token=store.createSession(first.id);
 store.db.exec("PRAGMA foreign_keys=OFF; BEGIN; CREATE TABLE old_users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','logist')),created_at TEXT NOT NULL); INSERT INTO old_users SELECT id,username,name,password_hash,CASE WHEN role='super_admin' THEN 'admin' ELSE role END,created_at FROM users; DROP TABLE users; ALTER TABLE old_users RENAME TO users; COMMIT; PRAGMA foreign_keys=ON;");store.close();store=openStore(file);
 assert.equal(store.session(token).role,'super_admin');assert.equal(store.login('second','roles-password-123').role,'admin');assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
 store.close();store=openStore(file);assert.equal(store.session(token).role,'super_admin');
 }finally{store.close();await rm(folder,{recursive:true,force:true});}
});

test('local recovery promotes the requested existing account and blank password edits preserve login',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'wb-recovery-')),file=join(folder,'portal.sqlite');let store=openStore(file);
 try{const root=store.addUser(input('root'),null,true),manager=store.addUser(input('manager','admin'),root);store.updateUser(manager.id,{name:'Updated',password:''},root);assert.equal(store.login('manager','roles-password-123').name,'Updated');store.close();
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('../src/administrator-cli.js',import.meta.url)),'manager'],{env:{...process.env,DATABASE_FILE:file},encoding:'utf8'});assert.match(output,/Администратор/);assert.equal(output.includes('roles-password-123'),false);store=openStore(file);assert.equal(store.login('manager','roles-password-123').role,'super_admin');assert.equal(store.activity()[0].action,'administrator_recovered');
 }finally{store.close();await rm(folder,{recursive:true,force:true});}
});
