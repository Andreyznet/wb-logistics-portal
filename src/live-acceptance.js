const API='https://logistics.wb.ru/transport-requests-service/api/v1/transport-requests';
export class LiveAcceptance {
 constructor(store,worker){this.store=store;this.worker=worker;}
 confirmed(card,id,e){return card?.transport_request_id===id&&card.route_id===e.routeId&&card.supplier_id===e.supplierId&&card.driver_id===e.driverId&&card.vehicle_id===e.vehicleId;}
 async reconcile(token,signal){
  for(const attempt of this.store.pendingAcceptances()){
   const result=await this.worker.get(`${API}/${attempt.id}`,token,signal),card=result?.data,e=attempt.expected;
   if(this.confirmed(card,attempt.id,e))this.store.finishAcceptance(attempt.id,e,200,result,'success',this.worker.clock().getTime());
   else if(card?.transport_request_id===attempt.id&&card.supplier_id!=null)this.store.finishAcceptance(attempt.id,e,409,{error:{message:'Карточка назначена другому перевозчику или экипажу.'},data:card},'rejected',this.worker.clock().getTime());
   // An unassigned card alone is not proof that an interrupted PUT never took effect.
  }
 }
 async take(candidate,token,signal,today){
  const config=this.store.botConfig();if(!config.enabled||!config.acceptanceEnabled||signal.aborted)return;
  const plans=this.store.requests().filter(p=>p.status==='waiting'&&p.service_date<=today&&p.route_id===candidate.routeId).sort((a,b)=>a.priority-b.priority||a.id-b.id);
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
   else if(status===429){finalState='failed';const retry=res.headers.get('retry-after');delay=Math.max(60000,/^\d+$/.test(retry||'')?Number(retry)*1000:(Date.parse(retry)-this.worker.clock().getTime())||60000);}
   else if(status>=400&&status<500){finalState=[408].includes(status)?'uncertain':[401,403,409].includes(status)?'failed':'rejected';}
   stop=[401,403].includes(status)||(status>=300&&status<400);
  }catch{response={error:{message:'Связь прервана. Результат принятия неизвестен; автоматический повтор запрещён до проверки WB.'}};}
  if(finalState==='uncertain'&&!response?.error?.message)response={...response,error:{message:'WB не подтвердил назначение. Результат неизвестен; требуется проверка карточки.'}};
  this.store.finishAcceptance(candidate.id,expected,status,response,finalState,this.worker.clock().getTime(),delay);
  if(stop){this.store.stopBot('WB отказал в доступе при принятии. Проверьте токен.');return;}
  if(status===429){const error=new Error('WB ограничил частоту запросов принятия.');error.delay=delay;throw error;}
 }
}
