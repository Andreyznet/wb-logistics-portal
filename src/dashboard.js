import {businessDate} from './store.js';
export function dashboard(store,user){
 const admin=['admin','super_admin'].includes(user.role),today=businessDate(store.timeZone),all=store.requests(),plans=admin?all:all.filter(p=>p.created_by===user.id),active=plans.filter(p=>p.status==='waiting'),ready=active.filter(p=>p.service_date<=today),future=active.filter(p=>p.service_date>today),c=store.botConfig(),runtime=store.getBotStatus({role:'admin'}).runtime||{};
 const alerts=[];
 if(ready.length&&!c.enabled)alerts.push({tone:'warning',title:'Бот остановлен',text:'Готовы к мониторингу: '+ready.length+'.'+(admin?' Включите бота, чтобы начать проверку.':' Обратитесь к менеджеру для запуска.')});
 if(c.enabled&&['auth_error','error'].includes(runtime.state))alerts.push({tone:'error',title:'Мониторинг требует внимания',text:admin?(runtime.error||'Проверьте настройки бота.'):'Менеджер проверяет работу мониторинга.'});
 if(runtime.warning)alerts.push({tone:'warning',title:'Часть карточек недоступна',text:admin?runtime.warning:'Мониторинг продолжается; часть карточек WB недоступна для проверки.'});
 const settings=admin?store.getBotSettings(user):null;
 if(admin&&!settings.hasToken)alerts.push({tone:'warning',title:'Нужен токен WB',text:'Сохраните токен в настройках бота.'});
 if(admin&&settings.tokenExpiresAt&&Date.parse(settings.tokenExpiresAt)<=Date.now())alerts.push({tone:'error',title:'Срок токена истёк',text:'Замените токен перед запуском мониторинга.'});
 const summarize=p=>({id:p.id,routeId:p.route_id,date:p.service_date,status:p.status,priority:p.priority,driver:p.driver_label,vehicle:p.vehicle_label,author:p.created_by_name,updatedAt:p.updated_at||p.created_at});
 return {scope:admin?'team':'mine',today,timeZone:store.timeZone,updatedAt:new Date().toISOString(),stats:{active:active.length,ready:ready.length,future:future.length,paused:plans.filter(p=>p.status==='paused').length,archived:plans.filter(p=>p.status==='archived').length,routes:new Set(active.map(p=>p.route_id)).size},bot:{enabled:c.enabled,state:runtime.state||'stopped',lastSuccessAt:runtime.lastSuccessAt||null,nextPollAt:runtime.nextPollAt||null,acceptanceEnabled:c.acceptanceEnabled},alerts,upcoming:active.slice(0,8).map(summarize),recent:[...plans].sort((a,b)=>String(b.updated_at||b.created_at).localeCompare(String(a.updated_at||a.created_at))||b.id-a.id).slice(0,5).map(summarize),...(admin?{admin:{tokenExpiresAt:settings.tokenExpiresAt,hasToken:settings.hasToken,requestsPerMinute:settings.requestsPerMinute,users:store.users().length,directory:store.catalogSummary().counts}}:{})};
}
