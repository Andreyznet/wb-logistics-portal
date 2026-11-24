function routeMarkup(id,name){return '<div class="history-route-label"><strong>'+esc(id)+'</strong>'+(name?'<span class="cell-sub route-name">'+esc(name)+'</span>':'')+'</div>';}
function logTone(kind,http){
 if(Number(http)>=400||/error|failed/.test(kind))return 'error';
 if(['acceptance_success','api_recovered','bot_enabled'].includes(kind))return 'success';
 if(/denied|cancelled|no_plans|warning|uncertain/.test(kind))return 'warning';
 if(/candidate|observation|snapshot|curl/.test(kind))return 'discovery';
 if(/request|response|acceptance_request/.test(kind))return 'network';
 if(/poll/.test(kind))return 'monitor';
 return 'system';
}
