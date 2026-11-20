const API='https://logistics.wb.ru/transport-requests-service/api/v1/transport-requests';
const weekday={Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:7};
export function localParts(date,timeZone){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));return{date:`${p.year}-${p.month}-${p.day}`,day:weekday[p.weekday],time:`${p.hour}:${p.minute}`};}
export function withinSchedule(config,date=new Date()){
  if(!config.scheduleEnabled)return true;
  const p=localParts(date,config.timeZone);
  if(config.startTime<config.endTime)return config.days.includes(p.day)&&p.time>=config.startTime&&p.time<config.endTime;
  return p.time>=config.startTime?config.days.includes(p.day):p.time<config.endTime&&config.days.includes(p.day===1?7:p.day-1);
}
class PollError extends Error{constructor(message,extra={}){super(message);Object.assign(this,extra);}}
export function previewCurl(id,plan){
  if(![id,plan.driver_id,plan.vehicle_id].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('Invalid preview IDs');
  if(plan.trailer_id)return null; // Field for trailers has not been confirmed in WB payloads.
  const body=JSON.stringify({vehicle:plan.vehicle_id,driver:plan.driver_id,freelancerID:null,accept_round_trip:false});
  return `curl.exe --request PUT "${API}/${id}/take-by-supplier" --header "Authorization: Bearer $env:WB_TOKEN" --header "Content-Type: application/json" --data-raw '${body}'`;
}
export class BotWorker {
  constructor(store,{fetchImpl=fetch,clock=()=>new Date()}={}){this.store=store;this.fetchImpl=fetchImpl;this.clock=clock;this.busy=false;this.controller=null;this.timer=null;this.revision=null;this.nextAt=0;this.lastAttempt=0;this.generation=0;this.failures=0;}
  start(){this.store.setBotRuntime({state:'stopped',nextPollAt:null});const run=()=>this.tick().catch(()=>this.store.setBotRuntime({state:'error',error:'Ошибка процесса мониторинга.'}));this.timer=setInterval(run,1000);this.timer.unref();void run();}
  stop(){clearInterval(this.timer);this.generation++;this.controller?.abort();}
  changed(){this.generation++;this.controller?.abort();this.revision=null;}
  async get(url,token,signal){
    const started=Date.now();const requestId=crypto.randomUUID();
    this.store.recordBotLog('request_started',{requestId,method:'GET',url});
    try { const data=await this.read(url,token,signal,requestId);this.store.recordBotLog('request_completed',{requestId,method:'GET',url,durationMs:Date.now()-started});return data; }
    catch(error){this.store.recordBotLog(signal.aborted?'request_cancelled':'request_failed',{requestId,method:'GET',url,durationMs:Date.now()-started,message:error instanceof PollError?error.message:'Чтение запроса прервано.'});throw error;}
  }
  async read(url,token,signal,requestId){
    let response;try{response=await this.fetchImpl(url,{method:'GET',redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{Accept:'application/json',Authorization:`Bearer ${token}`}});}catch(error){if(signal.aborted)throw error;throw new PollError('Сетевая ошибка или тайм-аут WB.');}
    this.store.recordBotLog('response_received',{requestId,method:'GET',url,httpStatus:response.status});
    if([401,403].includes(response.status))throw new PollError('WB отказал в доступе. Проверьте токен перед повторным включением.',{stop:true});
    if(response.status===429){const retry=response.headers.get('retry-after');const delay=retry&&/^\d+$/.test(retry)?Number(retry)*1000:Math.max(0,Date.parse(retry)-this.clock().getTime())||60000;throw new PollError('WB ограничил частоту запросов. Опрос отложен.',{delay:Math.max(60000,delay)});}
    if(response.status>=300&&response.status<400)throw new PollError('WB перенаправил запрос. Требуется проверка авторизации.',{stop:true});
    if(!response.ok)throw new PollError(`Ошибка WB: HTTP ${response.status}.`);
    if(!(response.headers.get('content-type')||'').includes('json'))throw new PollError('WB вернул страницу вместо JSON. Требуется ручная проверка.',{stop:true});
    try{return await response.json();}catch{throw new PollError('WB вернул некорректный JSON.');}
  }
  async tick(){
    const config=this.store.botConfig(),now=this.clock();
    if(this.revision!==config.revision){this.generation++;this.controller?.abort();this.revision=config.revision;}
    if(!config.enabled){this.controller?.abort();this.store.setBotRuntime({state:'stopped',nextPollAt:null});return;}
    if(false){this.controller?.abort();this.store.setBotRuntime({state:'outside_schedule',nextPollAt:null});return;}
    const today=localParts(now,config.timeZone).date;
    const plans=this.store.requests().filter(row=>row.status==='waiting'&&row.service_date>=today);
    if(!plans.length){this.controller?.abort();this.store.setBotRuntime({state:'no_plans',nextPollAt:null});return;}
    const exp=(()=>{try{return JSON.parse(Buffer.from(config.token.split('.')[1],'base64url').toString()).exp;}catch{return null;}})();
    if(!config.token||typeof exp==='number'&&exp*1000<=now.getTime()){this.store.stopBot('Токен отсутствует или истёк.');this.store.setBotRuntime({state:'auth_error',error:'Введите действующий токен и включите бота заново.',nextPollAt:null});return;}
    const due=Math.max(this.nextAt,this.lastAttempt+config.intervalSeconds*1000);
    if(this.busy)return;
    if(now.getTime()<due){this.store.setBotRuntime({state:'waiting',nextPollAt:new Date(due).toISOString(),monitoredRoutes:new Set(plans.map(p=>p.route_id)).size});return;}
    this.busy=true;this.lastAttempt=now.getTime();const generation=this.generation;
    const controller=new AbortController();this.controller=controller;
    const scopesForLog=plans.map(p=>({routeId:p.route_id,date:p.service_date})).filter((p,i,all)=>all.findIndex(x=>x.routeId===p.routeId&&x.date===p.date)===i);
    this.store.recordBotLog('poll_started',{routes:[...new Set(plans.map(p=>p.route_id))],scopes:scopesForLog,intervalSeconds:config.intervalSeconds,acceptanceEnabled:false});
    this.store.setBotRuntime({state:'polling',nextPollAt:null,lastAttemptAt:now.toISOString(),scopes:scopesForLog,error:null});
    try{
      const payload=await this.get(`${API}?filter=TO_DELIVERY`,config.token,controller.signal);
      const listReceivedAt=this.clock().toISOString();
      if(!Array.isArray(payload?.data)||payload.data.some(r=>!Number.isSafeInteger(r?.transport_request_id)||!Number.isSafeInteger(r?.route_id)||!Object.hasOwn(r,'supplier_id')))throw new PollError('Неожиданная структура списка WB.');
      if(new Set(payload.data.map(r=>r.transport_request_id)).size!==payload.data.length)throw new PollError('Повторные ID в списке WB.');
      const scopes=new Set(plans.map(p=>`${p.route_id}|${p.service_date}`));
      const matches=row=>{if(!row?.car_dt||!Number.isFinite(Date.parse(row.car_dt)))return false;return scopes.has(`${row.route_id}|${localParts(new Date(row.car_dt),config.timeZone).date}`);};
      const targets=payload.data.filter(row=>matches(row));const candidates=[];
      for(const row of targets){if(controller.signal.aborted||generation!==this.generation)return;if(row.supplier_id!==null)continue;
        const result=await this.get(`${API}/${row.transport_request_id}`,config.token,controller.signal);const card=result?.data;
        if(!card||card.transport_request_id!==row.transport_request_id||card.route_id!==row.route_id||!Object.hasOwn(card,'supplier_id')||typeof card.request_status!=='string'||typeof card.is_closed!=='boolean'||!card.car_dt||!Number.isFinite(Date.parse(card.car_dt)))throw new PollError('Неожиданная структура карточки WB.');
        if(matches(card)&&card.request_status==='created'&&card.is_closed===false&&card.supplier_id===null)candidates.push({id:card.transport_request_id,routeId:card.route_id,carDt:card.car_dt,cubature:card.cubature_value??null,pricePerKm:card.price_per_km??null,distanceKm:card.distance_km??null});
      }
      if(controller.signal.aborted||generation!==this.generation)return;
      for(const candidate of candidates){
        const plan=plans.filter(p=>p.route_id===candidate.routeId&&p.service_date===localParts(new Date(candidate.carDt),config.timeZone).date).sort((a,b)=>a.priority-b.priority||a.id-b.id)[0];
        candidate.planId=plan.id;
        candidate.curl=previewCurl(candidate.id,plan);
        candidate.previewNote=candidate.curl?'Только текст команды. Запрос принятия не отправлен.':'Команда не сформирована: требуется подтвердить поле прицепа в API WB.';
      }
      const events=this.store.recordBotCandidates(candidates,{source:`${API}?filter=TO_DELIVERY`,method:'GET',receivedAt:listReceivedAt,candidateIds:candidates.map(c=>c.id),response:payload});this.store.recordBotLog('poll_completed',{routes:[...new Set(plans.map(p=>p.route_id))],total:payload.data.length,targetRecords:targets.length,candidates:candidates.length,newEvents:events});this.failures=0;this.nextAt=this.clock().getTime()+config.intervalSeconds*1000;
      this.store.setBotRuntime({state:'waiting',lastSuccessAt:this.clock().toISOString(),nextPollAt:new Date(this.nextAt).toISOString(),total:payload.data.length,targetRecords:targets.length,candidates:candidates.length,newEvents:events,monitoredRoutes:new Set(plans.map(p=>p.route_id)).size,error:null});
    }catch(error){if(controller.signal.aborted||generation!==this.generation)return;
      this.store.recordBotLog('poll_failed',{message:error instanceof PollError?error.message:'Ошибка обработки ответа WB.'});
      if(error.stop){this.store.stopBot(error.message);this.store.setBotRuntime({state:'auth_error',error:error.message,nextPollAt:null});}
      else{this.failures++;const delay=Math.max(config.intervalSeconds*1000,error.delay||0,Math.min(900000,60000*2**Math.min(this.failures-1,4)));this.nextAt=this.clock().getTime()+delay;this.store.setBotRuntime({state:'error',error:error instanceof PollError?error.message:'Ошибка чтения ответа WB.',nextPollAt:new Date(this.nextAt).toISOString()});}
    }finally{this.busy=false;if(this.controller===controller)this.controller=null;}
  }
}

