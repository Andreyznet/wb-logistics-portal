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
