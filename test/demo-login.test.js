import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {openStore} from '../src/store.js';
import {createPortal,seedPreviewDemo} from '../src/server.js';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const apiSource=source.slice(source.indexOf('async function api('),source.indexOf('async function boot('));
async function serve(fn,{proxy=false,demo=true}={}){const store=openStore(':memory:');if(demo)seedPreviewDemo(store);const server=createPortal({store,trustProxy:proxy,demoMode:demo});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;try{await fn({store,origin});}finally{await new Promise(resolve=>server.close(resolve));store.close();}}
test('demo seed is repeatable; demo and manual login return a usable session and dashboard data',async()=>serve(async({store,origin})=>{
 const count=store.userCount();seedPreviewDemo(store);assert.equal(store.userCount(),count);
 for(const prefix of ['/portal-api/','/api/']){
  const session=await(await fetch(origin+prefix+'session')).json();assert.equal(session.demoMode,true);assert.equal(session.setupNeeded,false);
  const res=await fetch(origin+prefix+'login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'logist2026demo'})});assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/application\/json/);assert.equal((await res.json()).user.role,'super_admin');const cookie=res.headers.get('set-cookie').split(';')[0];assert.match(res.headers.get('set-cookie'),/SameSite=Lax/);
  for(const path of ['session','requests','users','catalog/summary','bot/settings','activity']){const response=await fetch(origin+prefix+path,{headers:{Cookie:cookie}});assert.equal(response.status,200,path);assert.ok(await response.json());}
  const logout=await fetch(origin+prefix+'logout',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(logout.status,200);assert.equal((await fetch(origin+prefix+'requests',{headers:{Cookie:cookie}})).status,401);
 }
}));
test('trusted preview proxy uses forwarded host and protocol without disabling origin checks',async()=>serve(async({origin})=>{
 const headers={Origin:'https://preview.example','X-Forwarded-Host':'preview.example','X-Forwarded-Proto':'https','Content-Type':'application/json'};const data=JSON.stringify({username:'admin',password:'logist2026demo'});
 const res=await fetch(origin+'/portal-api/login',{method:'POST',headers,body:data});assert.equal(res.status,200);assert.match(res.headers.get('set-cookie'),/SameSite=None; Secure/);
 const rejected=await fetch(origin+'/portal-api/login',{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:data});assert.equal(rejected.status,403);assert.match((await rejected.json()).error,/источник/);
},{proxy:true}));
test('production server never advertises demo login and ignores untrusted proxy headers',async()=>serve(async({origin})=>{
 const response=await fetch(origin+'/portal-api/session');const session=await response.json();assert.equal(session.demoMode,undefined);assert.equal(session.setupNeeded,true);
 const forged=await fetch(origin+'/portal-api/login',{method:'POST',headers:{Origin:'https://preview.example','X-Forwarded-Host':'preview.example','X-Forwarded-Proto':'https','Content-Type':'application/json'},body:'{}'});assert.equal(forged.status,403);
},{demo:false}));
test('API helper uses portal namespace and reports HTML or invalid JSON without a parser stack',async()=>{
 let request;const context=vm.createContext({state:{user:null},boot:async()=>{},fetch:async(path)=>{request=path;return new Response('<html>Preview login page</html>',{status:200,headers:{'Content-Type':'text/html'}});}});vm.runInContext(apiSource,context);
 await assert.rejects(()=>vm.runInContext("api('/api/login',{method:'POST',data:{}})",context),/Сервер вернул неверный ответ/);assert.equal(request,'/portal-api/login');
 context.fetch=async()=>new Response('{broken',{headers:{'Content-Type':'application/json'}});await assert.rejects(()=>vm.runInContext("api('/api/session')",context),/повреждённый JSON/);
 context.fetch=async()=>new Response(JSON.stringify({error:'Неверный логин или пароль'}),{status:401,headers:{'Content-Type':'application/json'}});await assert.rejects(()=>vm.runInContext("api('/api/login')",context),/Неверный логин/);
});
test('demo button and manual form submit use the same working login API',async()=>serve(async({origin})=>{
 const elements=new Map();for(const key of ['#auth-form','#demo-login','.form-error','[type=submit]'])elements.set(key,{disabled:false,textContent:''});const form=elements.get('#auth-form');form.querySelector=key=>elements.get(key);const app={innerHTML:''};let cookie='',boots=0;
 const context=vm.createContext({app,state:{session:{setupNeeded:false,demoMode:true},user:null},esc:String,brand:()=>'',themeButton:()=>'',bindThemeButton:()=>{},icon:()=>'',eyeIcon:()=>'',boot:async()=>{boots++;},FormData:class{*[Symbol.iterator](){yield ['username','admin'];yield ['password','logist2026demo'];}},document:{querySelector:key=>elements.get(key)||null},fetch:async(path,options)=>{const response=await fetch(origin+path,{...options,headers:{...options.headers,Origin:origin,...(cookie?{Cookie:cookie}:{})}});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return response;}});
 const auth=source.slice(source.indexOf('function renderAuth(){'),source.indexOf('function navItem('));vm.runInContext(apiSource+auth,context);vm.runInContext('renderAuth()',context);await elements.get('#demo-login').onclick();assert.equal(boots,1);assert.equal(elements.get('.form-error').textContent,'');assert.match(cookie,/portal_session=/);
 await form.onsubmit({preventDefault(){},currentTarget:form});assert.equal(boots,2);assert.equal(elements.get('[type=submit]').disabled,false);
}));

test('demo cannot falsely report enabled monitoring through settings API',async()=>serve(async({origin})=>{const login=await fetch(origin+'/portal-api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'logist2026demo'})});const cookie=login.headers.get('set-cookie').split(';')[0];const settings=(await(await fetch(origin+'/portal-api/bot/settings',{headers:{Cookie:cookie}})).json()).settings;const res=await fetch(origin+'/portal-api/bot/settings',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({...settings,enabled:true,token:'test-only-token'})});assert.equal(res.status,400);assert.match((await res.json()).error,/Демо не запускает мониторинг/);const status=await(await fetch(origin+'/portal-api/bot/public-status',{headers:{Cookie:cookie}})).json();assert.equal(status.enabled,false);}));
