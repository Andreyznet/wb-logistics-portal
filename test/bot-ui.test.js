import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('header and checkbox share state; stale poll cannot undo an immediate toggle',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('let botMutating=false'),source.indexOf('setInterval(()=>{if(!document.hidden)void updateHeaderBot();}'));
 const box={innerHTML:''},toggle={checked:true,disabled:false};let finishPoll;
 const context=vm.createContext({can:()=>true,state:{user:{role:'admin'},view:'bot',bot:{settings:{enabled:true}}},document:{querySelector:s=>s==='#header-bot'?box:s==='#bot-enabled'?toggle:null},esc:String,icon:()=>'',botStateNames:{waiting:'Ожидает проверки',stopped:'Выключен'},renderBotRuntime:()=>{},updateBotSettingsLock:()=>{},toast:()=>{},api:async(path,options)=>{
  if(path==='/api/bot/status?summary=1')return new Promise(resolve=>{finishPoll=resolve;});
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


test('settings lock follows running state and aggression displays seconds',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const block=source.slice(source.indexOf('function updateBotSettingsLock('),source.indexOf('function renderBotSettings('));
 const fields={disabled:false},save={disabled:false},hint={hidden:true},rate={value:'4'},seconds={textContent:''};const state={bot:{settings:{enabled:true}}};const context=vm.createContext({can:()=>true,state,Intl,document:{querySelector:key=>({'#bot-settings-fields':fields,'#bot-save':save,'#bot-lock-hint':hint,'#bot-rate':rate,'#bot-rate-hint':seconds}[key])}});vm.runInContext(block,context);vm.runInContext('updateBotSettingsLock();updateAggressionHint()',context);assert.equal(fields.disabled,true);assert.equal(save.disabled,true);assert.equal(hint.hidden,false);assert.match(seconds.textContent,/15 сек/);
 state.bot.settings.enabled=false;vm.runInContext('updateBotSettingsLock()',context);assert.equal(fields.disabled,false);assert.equal(save.disabled,false);for(const [value,expected]of [['1','60 сек'],['60','1 сек'],['7','8,57 сек']]){rate.value=value;vm.runInContext('updateAggressionHint()',context);assert.ok(seconds.textContent.includes(expected));}
 context.can=()=>false;vm.runInContext('updateBotSettingsLock()',context);assert.equal(fields.disabled,true);assert.equal(save.disabled,true);
});

test('request list refreshes accepted status without resetting filters and defers while editing',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const block=source.slice(source.indexOf('let requestRefreshBusy=false;'));let calls=0,renders=0;const dialog={open:false};const state={user:{id:1},view:'requests',query:'43495',filter:'active',page:2,requests:[{id:9,version:1,status:'waiting'}]};const context=vm.createContext({state,document:{hidden:false,activeElement:null,querySelector:()=>dialog},renderRequests:()=>{renders++;},setInterval:()=>{},api:async()=>{calls++;return {data:[{id:9,version:2,status:'paused',accepted_wb_id:1918620}]};}});vm.runInContext(block,context);await vm.runInContext('refreshRequestState()',context);assert.equal(renders,1);assert.equal(state.requests[0].accepted_wb_id,1918620);assert.equal(state.query,'43495');assert.equal(state.filter,'active');assert.equal(state.page,2);await vm.runInContext('refreshRequestState()',context);assert.equal(renders,1);dialog.open=true;await vm.runInContext('refreshRequestState()',context);assert.equal(calls,2);
});

test('plan wording distinguishes monitoring, future dates, stopped bot and processed requests',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const block=source.slice(source.indexOf('function planStatusLabel('),source.indexOf('const dateLabel='));const context=vm.createContext({state:{}});vm.runInContext(block,context);
 for(const [plan,on,label]of [[{status:'waiting',service_date:'2026-11-21'},true,'Мониторинг'],[{status:'waiting',service_date:'2026-11-21'},false,'Ожидает запуска'],[{status:'waiting',service_date:'2026-11-22'},true,'Ожидает даты'],[{status:'paused'},true,'На паузе'],[{status:'paused',accepted_wb_id:1918620},false,'Обработана'],[{status:'archived',accepted_wb_id:1918620},false,'В архиве']]){context.plan=plan;context.on=on;assert.equal(vm.runInContext("planStatusLabel(plan,on,'2026-11-21')",context),label);}
});


test('accepted date and time render as wrapping parts in status cell using portal timezone',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const block=source.slice(source.indexOf('function acceptedTimeMarkup('),source.indexOf('function requestRow('));const context=vm.createContext({state:{session:{timeZone:'Asia/Yekaterinburg'}}});vm.runInContext(block,context);
 const markup=vm.runInContext("acceptedTimeMarkup(Date.parse('2026-11-26T00:10:22Z'))",context);
 assert.match(markup,/<span>26.11.2026<\/span><span>05:10:22<\/span>/);assert.match(markup,/datetime="2026-11-26T00:10:22.000Z"/);
 assert.equal(vm.runInContext('acceptedTimeMarkup(null)',context),'');assert.equal(vm.runInContext("acceptedTimeMarkup('bad')",context),'');
});


test('manager saves bot settings without requesting administrator-only activity history',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');const start=source.indexOf("document.querySelector('#bot-form').onsubmit=async event=>{");const end=source.indexOf('\n  };',start)+6;
 const button={disabled:false},error={textContent:''},fields={'#bot-supplier':{value:'10095401'},'#bot-rate':{value:'12'},'#schedule-start':{value:'08:00'},'#schedule-end':{value:'20:00'},'#bot-token':{value:'new-test-token'}};
 const form={querySelector:s=>s==='[type=submit]'?button:error,querySelectorAll:()=>[]};let renders=0;const calls=[],messages=[];
 const context=vm.createContext({state:{user:{role:'admin'},bot:{settings:{revision:1,enabled:false}}},botMutating:false,botEpoch:0,document:{querySelector:s=>s==='#bot-form'?form:fields[s]},paintHeaderBot:()=>{},applyBotSnapshot:()=>{},renderBotSettings:()=>renders++,toast:v=>messages.push(v),api:async(path,options)=>{calls.push(path);assert.equal(path,'/api/bot/settings','saving must never access the restricted history endpoint');assert.equal(options.data.requestsPerMinute,12);return {settings:{enabled:false,revision:2}};}});
 vm.runInContext(source.slice(start,end),context);await form.onsubmit({preventDefault(){},currentTarget:form});
 assert.deepEqual(calls,['/api/bot/settings']);assert.deepEqual(messages,['Настройки бота сохранены']);assert.equal(error.textContent,'');assert.equal(renders,1);assert.equal(fields['#bot-token'].value,'');assert.equal(button.disabled,false);
});
