export function monitoringDue(plan,now=new Date(),timeZone='Asia/Yekaterinburg'){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
 return plan.service_date+'T'+(plan.service_time||'00:00')<=`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
