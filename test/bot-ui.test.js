import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('header and checkbox share state; stale poll cannot undo an immediate toggle',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('let botMutating=false'),source.indexOf('setInterval(()=>{if(!document.hidden)void updateHeaderBot();}'));
 const box={innerHTML:''},toggle={checked:true,disabled:false};let finishPoll;
 const context=vm.createContext({state:{user:{role:'admin'},view:'bot',bot:{settings:{enabled:true}}},document:{querySelector:s=>s==='#header-bot'?box:s==='#bot-enabled'?toggle:null},esc:String,icon:()=>'',botStateNames:{waiting:'Ожидает проверки',stopped:'Выключен'},renderBotRuntime:()=>{},toast:()=>{},api:async(path,options)=>{
  if(path==='/api/bot/status')return new Promise(resolve=>{finishPoll=resolve;});
  if(!options)return{settings:{enabled:true,revision:1}};
  assert.equal(options.data.enabled,false);return{settings:{enabled:false,revision:2},runtime:{state:'stopped'}};
 }});
 vm.runInContext(block,context);
 const poll=vm.runInContext('updateHeaderBot()',context);
 await vm.runInContext('setBotEnabled(false)',context);
 assert.equal(toggle.checked,false);assert.match(box.innerHTML,/Бот остановлен/);
 finishPoll({settings:{enabled:true,revision:1},runtime:{state:'waiting'}});await poll;
 assert.equal(toggle.checked,false);assert.match(box.innerHTML,/Бот остановлен/);
 assert.equal(toggle.disabled,false);
});

test('found candidate stays neutral until an acceptance outcome is recorded and WB text is escaped',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const block=source.slice(source.indexOf('function acceptanceMarkup('),source.indexOf('function resultElement('));const context=vm.createContext({state:{bot:{}},esc:value=>String(value).replaceAll('<','&lt;')});vm.runInContext(block,context);assert.match(vm.runInContext('acceptanceMarkup(1)',context),/Запрос не отправлялся/);context.state.bot.outcomes=[{id:1,kind:'acceptance_error',payload:{message:'<WB error>'}}];assert.match(vm.runInContext('acceptanceMarkup(1)',context),/outcome-error/);assert.match(vm.runInContext('acceptanceMarkup(1)',context),/&lt;WB error>/);context.state.bot.outcomes[0].kind='acceptance_success';assert.match(vm.runInContext('acceptanceMarkup(1)',context),/outcome-ok/);
});
test('status conflict stays visible for logist and is not overwritten by refresh success or failure',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const a=source.indexOf('async function changeStatus(');const b=source.indexOf('\n',a);const block=source.slice(a,b);for(const refreshFails of [false,true]){const notices=[];let loaded=false;const context=vm.createContext({state:{user:{role:'logist'},requests:[{id:5,version:1}]},confirm:()=>true,api:async()=>{throw new Error('Автомобиль уже запланирован на эту дату в заявке №8.');},load:async()=>{loaded=true;if(refreshFails)throw new Error('offline');},render:()=>{},toast:(message,type)=>notices.push({message,type}),refresh:()=>{throw new Error('Must not call noisy refresh');}});vm.runInContext(block,context);await vm.runInContext("changeStatus(5,'waiting')",context);assert.equal(loaded,true);assert.equal(notices.length,1);assert.equal(notices[0].type,'error');assert.match(notices[0].message,/заявке №8/);}
});

test('live acceptance switch persists immediately and rolls back on save failure',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const block=source.slice(source.indexOf('let botMutating=false'),source.indexOf('setInterval(()=>{if(!document.hidden)void updateHeaderBot();}'));
 for(const fails of [false,true]){const live={checked:true,disabled:false},supplier={value:'10095401'},notices=[];let posted;
 const context=vm.createContext({state:{user:{role:'super_admin'},view:'bot',bot:{settings:{enabled:true,acceptanceEnabled:false}}},document:{querySelector:s=>s==='#bot-live'?live:s==='#bot-supplier'?supplier:null},esc:String,icon:()=>'',botStateNames:{},renderBotRuntime:()=>{},toast:(message,type)=>notices.push({message,type}),api:async(path,options)=>{if(!options)return{settings:{revision:1,enabled:true,acceptanceEnabled:false,supplierId:0}};posted=options.data;if(fails)throw new Error('save failed');return{settings:{...posted,revision:2},runtime:{state:'waiting'}};}});
 vm.runInContext(block,context);await vm.runInContext('setLiveAcceptance(true)',context);assert.equal(posted.acceptanceEnabled,true);assert.equal(posted.supplierId,10095401);assert.equal(live.disabled,false);assert.equal(live.checked,!fails);assert.equal(context.state.bot.settings.acceptanceEnabled,!fails);assert.match(notices[0].message,fails?/save failed/:/включено и сохранено/);}
});
