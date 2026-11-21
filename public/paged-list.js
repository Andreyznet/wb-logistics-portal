/* Shared paged-search state: one request at a time, stale replies cannot replace a newer search. */
class PagedCollection {
 constructor(fetchPage,onChange=()=>{}){this.fetchPage=fetchPage;this.onChange=onChange;this.generation=0;this.rows=[];this.query='';this.nextCursor=null;this.busy=false;this.done=false;this.error='';this.source='';this.seen=new Set();this.destroyed=false;}
 notify(){if(!this.destroyed)this.onChange(this);}
 reset(query='',{load=true}={}){this.generation++;this.controller?.abort();this.query=query;this.rows=[];this.nextCursor=null;this.busy=false;this.done=false;this.error='';this.source='';this.seen.clear();this.notify();return load?this.loadMore():Promise.resolve(false);}
 async loadMore(){if(this.destroyed||this.busy||this.done)return false;const generation=this.generation,cursor=this.nextCursor;this.controller=new AbortController();this.busy=true;this.error='';this.notify();
  try{const page=await this.fetchPage({query:this.query,cursor,signal:this.controller.signal});if(this.destroyed||generation!==this.generation)return false;if(!Array.isArray(page?.data))throw new Error('Некорректная страница справочника.');const next=page.nextCursor||null;if(next&&(next===cursor||this.seen.has(next)))throw new Error('Источник повторил страницу. Откройте список заново.');for(const row of page.data){if(!Number.isSafeInteger(row.id)||typeof row.label!=='string')throw new Error('Некорректная запись справочника.');}if(next)this.seen.add(next);const known=new Set(this.rows.map(row=>row.id));for(const row of page.data){if(!Number.isSafeInteger(row.id)||typeof row.label!=='string')throw new Error('Некорректная запись справочника.');if(!known.has(row.id)){known.add(row.id);this.rows.push(row);}}
   this.nextCursor=next;this.done=!next;this.source=page.source||'saved';return true;
  }catch(error){if(generation!==this.generation||this.destroyed||error.name==='AbortError')return false;this.error=error.message||'Ошибка загрузки справочника.';return false;}
  finally{if(generation===this.generation&&!this.destroyed){this.busy=false;this.notify();}}
 }
 destroy(){this.destroyed=true;this.generation++;this.controller?.abort();}
}
