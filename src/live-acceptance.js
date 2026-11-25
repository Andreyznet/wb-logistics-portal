import {monitoringDue} from './monitoring-time.js';
const API='https://logistics.wb.ru/transport-requests-service/api/v1/transport-requests';
export class LiveAcceptance {
 constructor(store,worker){this.store=store;this.worker=worker;}
 confirmed(card,id,e){return card?.transport_request_id===id&&card.route_id===e.routeId&&card.supplier_id===e.supplierId&&card.driver_id===e.driverId&&card.vehicle_id===e.vehicleId;}
 async reconcile(token,signal){
  for(const attempt of this.store.pendingAcceptances()){
   if(attempt.response&&JSON.parse(attempt.response).httpStatus===429&&attempt.retry_at>this.worker.clock().getTime())continue;
   if((this.worker.deniedCards?.get(attempt.id)||0)>this.worker.clock().getTime())continue;
   let result;try{result=await this.worker.get(`${API}/${attempt.id}`,token,signal);}catch(error){if(!error.cardDenied)throw error;this.worker.deniedCards?.set(attempt.id,this.worker.clock().getTime()+300000);this.store.recordBotLog('card_access_denied',{id:attempt.id,httpStatus:403,message:error.message+' Результат прежнего принятия остаётся неизвестным; повторный PUT не отправлен.'});continue;}const card=result?.data,e=attempt.expected;
   if(this.confirmed(card,attempt.id,e))this.store.finishAcceptance(attempt.id,e,200,result,'success',this.worker.clock().getTime());
   else if(card?.transport_request_id===attempt.id&&card.route_id===e.routeId&&card.supplier_id!=null)this.store.finishAcceptance(attempt.id,e,409,{error:{message:'Карточка назначена другому перевозчику или экипажу.'},data:card},'rejected',this.worker.clock().getTime());
   // An unassigned card alone is not proof that an interrupted PUT never took effect.
  }
 }
 async take(candidate,token,signal,today){
  const config=this.store.botConfig();if(!config.enabled||signal.aborted)return;
  const plans=this.store.requests().filter(p=>p.status==='waiting'&&!p.observe_only&&monitoringDue(p,this.worker.clock(),config.timeZone)&&p.route_id===candidate.routeId).sort((a,b)=>a.priority-b.priority||a.id-b.id);
  if(plans.length&&(!Number.isSafeInteger(config.supplierId)||config.supplierId<=0)){const error=new Error('Укажите ID компании в настройках бота перед принятием заявок.');error.stop=true;throw error;}
  let expected,plan;
  for(const p of plans){if(p.trailer_id){this.store.recordBotLog('acceptance_error',{id:candidate.id,routeId:candidate.routeId,message:'Принятие с прицепом отключено: поле API ещё не подтверждено.'});continue;}const e=this.store.claimAcceptance(candidate.id,p,this.worker.clock().getTime());if(e){expected=e;plan=p;break;}}
  if(!expected)return;
  const url=`${API}/${candidate.id}/take-by-supplier`,body={vehicle:plan.vehicle_id,driver:plan.driver_id,freelancerID:null,accept_round_trip:false};
  this.store.recordBotLog('acceptance_request',{id:candidate.id,planId:plan.id,method:'PUT',url,body});
  let status=0,response,finalState='uncertain',delay=60000,stop=false;
  try{
   const res=await this.worker.fetchImpl(url,{method:'PUT',redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{Accept:'application/json','Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
   status=res.status;
   const text=(await res.text()).replaceAll(token,'[скрыто]');try{response=JSON.parse(text);}catch{response={error:{message:'WB вернул не JSON. Результат принятия неизвестен.'},raw:text};}
   if(res.ok&&response?.success!==false&&this.confirmed(response?.data,candidate.id,expected))finalState='success';
   else if(status===429){finalState='uncertain';const retry=res.headers.get('retry-after');delay=Math.max(60000,/^\d+$/.test(retry||'')?Number(retry)*1000:(Date.parse(retry)-this.worker.clock().getTime())||60000);}
   else if(status>=400&&status<500){finalState=[408].includes(status)?'uncertain':[401,403,409].includes(status)?'failed':'rejected';}
   if(status===429)response={...response,error:{...response?.error,message:'WB вернул HTTP 429. Результат принятия неизвестен; повторный PUT запрещён до подтверждения состояния заявки.'}};
   stop=[401,403].includes(status)||(status>=300&&status<400);
  }catch{response={error:{message:'Связь прервана. Результат принятия неизвестен; автоматический повтор запрещён до проверки WB.'}};}
  if(finalState==='uncertain'&&!response?.error?.message)response={...response,error:{message:'WB не подтвердил назначение. Результат неизвестен; требуется проверка карточки.'}};
  this.store.finishAcceptance(candidate.id,expected,status,response,finalState,this.worker.clock().getTime(),delay);
  if(stop){this.store.stopBot('WB отказал в доступе при принятии. Проверьте токен.');return;}
  if(status===429){const error=new Error('WB ограничил частоту запросов принятия.');error.delay=delay;throw error;}
 }
}
