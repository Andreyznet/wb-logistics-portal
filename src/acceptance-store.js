export function createAcceptanceStore({db,transaction,botConfig,recordAcceptanceResult,audit,fail}){
 db.exec(`CREATE TABLE IF NOT EXISTS acceptance_attempts(id INTEGER PRIMARY KEY,plan_id INTEGER NOT NULL,driver_id INTEGER NOT NULL,vehicle_id INTEGER NOT NULL,state TEXT NOT NULL,tries INTEGER NOT NULL,updated_at INTEGER NOT NULL,retry_at INTEGER NOT NULL,expected TEXT NOT NULL,response TEXT);`);
 const pending=()=>db.prepare("SELECT * FROM acceptance_attempts WHERE state IN ('pending','uncertain')").all().map(row=>({...row,expected:JSON.parse(row.expected)}));
 function claim(id,plan,now){return transaction(()=>{
  const config=botConfig(),fresh=db.prepare('SELECT * FROM requests WHERE id=?').get(plan.id);
  if(!config.enabled||!fresh||fresh.status!=='waiting'||fresh.observe_only||config.supplierId<=0||fresh.version!==plan.version)return null;
  if(fresh.trailer_id)return null;
  const old=db.prepare('SELECT * FROM acceptance_attempts WHERE id=?').get(id);
  if(old&&(old.state!=='failed'||old.tries>=3||old.retry_at>now))return null;
  if(db.prepare("SELECT id FROM acceptance_attempts WHERE (plan_id=? OR driver_id=? OR vehicle_id=?) AND state IN ('pending','uncertain','success') AND (state<>'success' OR plan_id=?)").get(plan.id,plan.driver_id,plan.vehicle_id,plan.id))return null;
  const expected={planId:plan.id,driverId:plan.driver_id,vehicleId:plan.vehicle_id,supplierId:config.supplierId,routeId:plan.route_id};
  db.prepare("INSERT INTO acceptance_attempts VALUES(?,?,?,?, 'pending',1,?,0,?,NULL) ON CONFLICT(id) DO UPDATE SET plan_id=excluded.plan_id,driver_id=excluded.driver_id,vehicle_id=excluded.vehicle_id,state='pending',tries=tries+1,updated_at=excluded.updated_at,expected=excluded.expected,response=NULL").run(id,plan.id,plan.driver_id,plan.vehicle_id,now,JSON.stringify(expected));return expected;
 });}
 function finish(id,expected,httpStatus,response,state,now,retryDelay=60000){
  // The durable pending intent continues to reserve the crew until result and plan updates are persisted.
  return transaction(()=>{
  const result=recordAcceptanceResult({id,routeId:expected.routeId,httpStatus,response,expected,inTransaction:true});
  const finalState=result.kind==='acceptance_success'?'success':state;
  db.prepare('UPDATE acceptance_attempts SET state=?,updated_at=?,retry_at=?,response=? WHERE id=?').run(finalState,now,now+retryDelay,JSON.stringify({httpStatus,response}),id);
   if(finalState==='success'){
    db.prepare("UPDATE requests SET status='paused',version=version+1,updated_at=? WHERE status='waiting' AND observe_only=0 AND (id=? OR driver_id=? OR vehicle_id=?)").run(new Date(now).toISOString(),expected.planId,expected.driverId,expected.vehicleId);
    audit(null,'request_accepted',expected.planId,'Заявка WB №'+id+' принята; планы этого экипажа приостановлены.');
   }
  return finalState;});
 }
 function getAttempt(id,actor){if(actor?.role!=='super_admin')fail(403,'Ответ принятия доступен администратору.');const row=db.prepare('SELECT * FROM acceptance_attempts WHERE id=?').get(id);if(!row)fail(404,'Попытка не найдена.');return {...row,expected:JSON.parse(row.expected),response:row.response?JSON.parse(row.response):null};}
 return {pendingAcceptances:pending,claimAcceptance:claim,finishAcceptance:finish,getAcceptanceAttempt:getAttempt};
}
