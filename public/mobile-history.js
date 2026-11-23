// Same server pagination, filters and permissions as desktop, with touch-friendly cards.
class MobileHistory {
 constructor(element,kind){this.element=element;this.kind=kind;this.page=1;this.sorters=[{field:'id',dir:'desc'}];this.rows=[];this.total=0;this.pages=1;this.controller=null;this.destroyed=false;void this.replaceData();}
 getPage(){return this.page;}getFilters(){return [];}getSorters(){return this.sorters;}
 setPage(page){this.page=page;return Promise.resolve();}clearHeaderFilter(){}
 destroy(){this.destroyed=true;this.controller?.abort();}
 async replaceData(){
  this.controller?.abort();const controller=new AbortController();this.controller=controller;this.element.setAttribute('aria-busy','true');
  if(!this.rows.length)this.element.innerHTML='<div class="mobile-history-empty" role="status">Загружаем…</div>';
  try{const result=await api('/api/bot/history/'+this.kind+'?'+historyParams(this.kind,{page:this.page,size:10,sorters:this.sorters}),{signal:controller.signal});
   if(this.destroyed||controller.signal.aborted)return;if(this.page===1)historyAnchors[this.kind]=result.maxId;
   this.rows=result.data.map(this.kind==='events'?mapFoundHistory:mapMonitorHistory);this.total=result.total;this.pages=result.last_page;
   if(this.page>this.pages){this.page=this.pages;return this.replaceData();}this.paint();
  }catch(error){if(controller.signal.aborted||this.destroyed)return;this.element.innerHTML='<div class="mobile-history-empty"><p role="alert">'+esc(error.message)+'</p><button class="secondary" data-retry>Повторить</button></div>';this.element.querySelector('[data-retry]').onclick=()=>void this.replaceData();}
  finally{if(!this.destroyed&&this.controller===controller)this.element.setAttribute('aria-busy','false');}
 }
 paint(){
  const events=this.kind==='events',privileged=can('found.details')||can('found.delete');
  this.element.innerHTML=`<div class="mobile-history-top"><span>Найдено: ${this.total}</span><select aria-label="Порядок записей" data-order><option value="desc" ${this.sorters[0].dir==='desc'?'selected':''}>Сначала новые</option><option value="asc" ${this.sorters[0].dir==='asc'?'selected':''}>Сначала старые</option></select></div><div class="mobile-history-cards">${this.rows.length?this.rows.map(r=>events?`<article class="mobile-found-card"><div class="mobile-found-head"><a class="route-id" href="https://logistics.wildberries.ru/external-logistics/transport-requests/${r.requestId}" target="_blank" rel="noopener noreferrer">WB №${r.requestId}</a><strong>Маршрут ${r.routeId}</strong></div><dl><div><dt>Подача</dt><dd>${esc(timeLabel(r.payload.carDt))}</dd></div><div><dt>Обнаружено</dt><dd>${esc(timeLabel(r.created_at,true))}</dd></div></dl><div class="mobile-found-outcome">${r.outcome}</div>${privileged?`<div class="mobile-found-actions">${can('found.details')&&r.payload.curl?`<button class="secondary" data-curl="${r.id}" aria-label="Посмотреть cURL">${icon('code')}</button>`:''}${can('found.details')&&r.payload.snapshotId?`<button class="secondary" data-snapshot="${r.payload.snapshotId}" aria-label="Скачать ответ WB">${icon('download')}</button>`:''}${can('found.details')&&r.outcomeKind?`<button class="secondary" data-response="${r.requestId}" aria-label="Ответ принятия">${icon('file')}</button>`:''}${can('found.delete')?`<button class="secondary is-danger" data-delete="${r.id}" aria-label="Удалить найденную запись">${icon('trash')}</button>`:''}</div>`:''}</article>`:`<article class="mobile-found-card"><div class="mobile-found-head"><strong>${esc(r.event)}</strong><span class="mobile-log-http ${Number(r.http)>=400?'is-danger':''}">${r.http?'HTTP '+esc(r.http):''}</span></div><small>${esc(r.time)}${r.duration?' · '+esc(r.duration)+' мс':''}</small><p class="mobile-log-result">${esc(r.result)}</p>${r.curl?`<button class="secondary" data-curl="${r.id}">cURL</button>`:''}</article>`).join(''):'<div class="mobile-history-empty">Записей пока нет</div>'}</div><div class="mobile-history-pager"><button class="secondary" data-prev ${this.page<=1?'disabled':''}>Назад</button><span>${this.page} / ${this.pages}</span><button class="secondary" data-next ${this.page>=this.pages?'disabled':''}>Далее</button></div>`;
  this.element.querySelector('[data-order]').onchange=e=>{this.sorters=[{field:'id',dir:e.target.value}];this.page=1;void this.replaceData();};
  for(const [selector,step]of [['[data-prev]',-1],['[data-next]',1]])this.element.querySelector(selector).onclick=()=>{this.page+=step;void this.replaceData();};
  this.element.querySelectorAll('[data-curl]').forEach(b=>b.onclick=()=>{const r=this.rows.find(r=>r.id===Number(b.dataset.curl));showCurlPreview(events?r.payload.curl:r.curl);});
  this.element.querySelectorAll('[data-snapshot]').forEach(b=>b.onclick=()=>void downloadBotSnapshot(Number(b.dataset.snapshot)));
  this.element.querySelectorAll('[data-response]').forEach(b=>b.onclick=()=>void downloadAttemptResponse(Number(b.dataset.response)));
  this.element.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>void deleteFoundEvent(this.rows.find(r=>r.id===Number(b.dataset.delete))));
 }
}
