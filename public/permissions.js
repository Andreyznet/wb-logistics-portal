async function renderPermissions(){
 const root=document.querySelector('#content');
 root.innerHTML=pageHead('Права доступа','Настройки вкладок и действий для каждой роли.')+'<section class="card dashboard-body" role="status">Загружаем права…</section>';
 try{
  let data=await api('/api/admin/permissions'),role='admin',dirty=false,saving=false,message='';
  const paint=()=>{
   if(state.view!=='permissions')return;
   root.innerHTML=pageHead('Права доступа','Изменения действуют для всей роли. Сервер проверяет права при каждом запросе.')+`<section class="card access-panel"><div class="panel-intro"><div><h2>Роли сотрудников</h2><p>Администратор всегда имеет полный доступ. Остальным ролям можно разрешить или запретить отдельные функции.</p></div></div><div class="access-role-tabs" role="tablist" aria-label="Роль сотрудника">${['admin','logist','super_admin'].map(r=>`<button type="button" role="tab" aria-selected="${r===role}" data-access-role="${r}" ${saving?'disabled':''}>${roleLabel(r)}</button>`).join('')}</div><form id="access-form"><div class="access-groups">${['Вкладки','Действия'].map(group=>`<fieldset ${role==='super_admin'||saving?'disabled':''}><legend>${group}</legend>${data.definitions.filter(d=>d.group===group).map(d=>`<label class="access-option"><input type="checkbox" name="${d.key}" ${data.matrix[role][d.key]?'checked':''}><span>${esc(d.label)}${d.parent?'<small>Требуется вкладка «'+esc(data.definitions.find(p=>p.key===d.parent).label)+'»</small>':''}</span></label>`).join('')}</fieldset>`).join('')}</div><p class="access-note">Управлять администраторами и самой панелью прав может только администратор. Право управления пользователями не позволяет другим ролям назначать администратора.</p><p class="access-message ${message?'error-box':''}" role="status">${esc(message|| (dirty?'Есть несохранённые изменения.':'Изменения применяются после сохранения.'))}</p><div class="access-footer"><button type="button" class="secondary" data-access-reset ${role==='super_admin'||saving?'disabled':''}>Стандартные права роли</button><button type="submit" class="primary" ${!dirty||saving?'disabled':''}>${saving?'Сохраняем…':'Сохранить права'}</button></div></form></section>`;
   root.querySelectorAll('[data-access-role]').forEach(b=>b.onclick=()=>{role=b.dataset.accessRole;paint();});
   const form=root.querySelector('#access-form');
   form.onchange=e=>{
    if(e.target.type!=='checkbox')return;const key=e.target.name,on=e.target.checked;data.matrix[role][key]=on;
    const def=data.definitions.find(d=>d.key===key);if(on&&def.parent)data.matrix[role][def.parent]=true;
    if(!on)for(const child of data.definitions.filter(d=>d.parent===key))data.matrix[role][child.key]=false;
    dirty=true;message='';const focus=key;paint();root.querySelector('[name="'+focus+'"]')?.focus();
   };
   root.querySelector('[data-access-reset]').onclick=()=>{data.matrix[role]={...data.defaults[role]};dirty=true;message='';paint();};
   form.onsubmit=async e=>{e.preventDefault();saving=true;message='';paint();try{data=await api('/api/admin/permissions',{method:'POST',data:{matrix:data.matrix,revision:data.revision}});dirty=false;toast('Права сохранены');}catch(error){message=error.message;}finally{saving=false;paint();}};
  };paint();
 }catch(error){if(state.view==='permissions')root.innerHTML=pageHead('Права доступа','Не удалось загрузить настройки.')+`<section class="card dashboard-body"><p class="error-box" role="alert">${esc(error.message)}</p><button class="secondary" id="access-retry">Повторить</button></section>`;root.querySelector('#access-retry')?.addEventListener('click',()=>void renderPermissions());}
}
setInterval(async()=>{
 if(!state.user||document.hidden||state.view==='permissions')return;
 try{const {permissions}=await api('/api/access');if(JSON.stringify(permissions)!==JSON.stringify(state.session.permissions)){await load();render();toast('Права доступа обновлены администратором');}}catch{}
},30000);
