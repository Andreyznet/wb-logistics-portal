// Authenticated, role-filtered synchronization feed for the Android foreground client.
export function mobileSync(store,user,query){
 const admin=['admin','super_admin'].includes(user.role),runtime=store.getBotStatus({role:'admin'},true).runtime||{};
 const max=store.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM bot_logs').get().id;
 const since=query.since==null?max:Number(query.since);
 if(!Number.isSafeInteger(since)||since<0){const e=new Error('Некорректный курсор уведомлений.');e.status=400;throw e;}
 const kinds=['bot_enabled','bot_disabled','poll_failed','api_error','api_recovered'];
 const rows=store.db.prepare('SELECT id,kind,payload,created_at FROM bot_logs WHERE id>? AND kind IN ('+kinds.map(()=>'?').join(',')+') ORDER BY id LIMIT 100').all(since,...kinds);
 const events=rows.map(row=>{const p=JSON.parse(row.payload);return {id:row.id,kind:row.kind,at:row.created_at,message:admin?p.message:row.kind==='bot_enabled'?'Бот запущен.':row.kind==='bot_disabled'?'Бот остановлен.':row.kind==='api_recovered'?'Связь с API восстановлена.':'В работе бота произошла ошибка. Сообщите менеджеру.'};});
 return {user:{id:user.id,name:user.name,role:user.role},cursor:rows.length===100?rows.at(-1).id:max,hasMore:rows.length===100,bot:{enabled:store.botConfig().enabled,error:runtime.error?(admin?runtime.error:'Ошибка работы бота. Сообщите менеджеру.'):null,apiErrors:Object.keys(runtime.apiIssues||{}).length},events,alerts:store.userAlerts(user),notification:store.notificationSettings(user.id)};
}
