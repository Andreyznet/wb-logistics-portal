async function renderKnowledge(){
 const root=document.querySelector('#content');
 root.innerHTML=pageHead('База знаний','Инструкции для вашей роли: '+roleLabel(state.user.role))+ '<section class="card knowledge-loading" role="status">Загружаем инструкции…</section>';
 try{
  const {data}=await api('/api/knowledge');if(state.view!=='knowledge')return;
  root.innerHTML=pageHead('База знаний','Инструкции для вашей роли: '+roleLabel(state.user.role))+`<section class="card knowledge-toolbar"><div class="search">${icon('search')}<input id="knowledge-search" type="search" placeholder="Как создать заявку, обновить токен…" aria-label="Поиск по базе знаний"></div><span id="knowledge-count" role="status"></span></section><div class="knowledge-layout"><nav class="card knowledge-toc" aria-label="Темы базы знаний"></nav><div class="knowledge-articles"></div></div>`;
  const list=root.querySelector('.knowledge-articles'),toc=root.querySelector('.knowledge-toc');
  const draw=()=>{const q=root.querySelector('#knowledge-search').value.trim().toLocaleLowerCase('ru');const matches=data.filter(a=>[a.title,a.category,...a.paragraphs,...a.steps].join(' ').toLocaleLowerCase('ru').includes(q));
   root.querySelector('#knowledge-count').textContent='Найдено: '+matches.length;
   toc.innerHTML=matches.map(a=>`<a href="#knowledge-${esc(a.id)}">${esc(a.title)}</a>`).join('');
   list.innerHTML=matches.length?matches.map(a=>`<details class="card knowledge-article" id="knowledge-${esc(a.id)}" ${q?'open':''}><summary><span class="knowledge-category">${esc(a.category)}</span><h2>${esc(a.title)}</h2>${icon('plus')}</summary><div class="knowledge-body">${a.paragraphs.map(p=>`<p>${esc(p)}</p>`).join('')}${a.steps.length?`<h3>Порядок действий</h3><ol>${a.steps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol>`:''}</div></details>`).join(''):'<section class="card knowledge-loading">Ничего не найдено. Попробуйте другое слово.</section>';
   toc.querySelectorAll('a').forEach(link=>link.onclick=e=>{e.preventDefault();const article=document.getElementById(link.hash.slice(1));article.open=true;article.scrollIntoView({behavior:'smooth',block:'start'});});
  };root.querySelector('#knowledge-search').oninput=draw;draw();
 }catch(error){if(state.view==='knowledge')root.innerHTML=pageHead('База знаний','Инструкции по работе с порталом')+`<section class="card knowledge-loading"><p role="alert">${esc(error.message)}</p><button class="secondary" id="knowledge-retry">Повторить</button></section>`;root.querySelector('#knowledge-retry')?.addEventListener('click',renderKnowledge);}
}
