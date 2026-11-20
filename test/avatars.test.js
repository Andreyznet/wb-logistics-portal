import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.js';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/e0AAAAASUVORK5CYII=';
test('avatars persist, preserve roles and reject unsafe formats',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wb-avatar-')),file=join(dir,'portal.sqlite');let store=openStore(file);
 try{const root=store.addUser({username:'root',name:'Root',password:'password-12345'},null,true),logist=store.addUser({username:'user',name:'User',password:'password-12345'},root);assert.match(logist.avatar,/avatars\//);
 assert.equal(store.saveAvatar({preset:'frog'},logist).avatar,'/avatars/frog.svg');assert.throws(()=>store.saveAvatar({preset:'../../foo'},logist));assert.throws(()=>store.saveAvatar({image:'data:image/svg+xml;base64,PHN2Zy8+'},logist));assert.throws(()=>store.saveAvatar({image:'data:image/png;base64,YmFk'},logist));
 const result=store.saveAvatar({image:png,user_id:root.id,role:'super_admin'},logist);assert.equal(result.role,'logist');assert.match(result.avatar,/\/api\/users\/2\/avatar\?v=/);assert.equal(store.getAvatar(logist.id).mime,'image/png');assert.match(store.users().find(u=>u.id===root.id).avatar,/\/avatars\//);
 store.close();store=openStore(file);assert.equal(store.login('user','password-12345').avatar,result.avatar);assert.equal(Buffer.from(store.getAvatar(logist.id).image).toString('base64'),png.split(',')[1]);assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
