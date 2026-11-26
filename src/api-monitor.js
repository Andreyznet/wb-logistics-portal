// Observe real requests only; never probe or retry a mutating endpoint.
export const catalogEndpoint=endpoint=>/\/(routecar\/v1\/routecars|suppliers\/transport|user-partnerships\/drivers\/list)(?:$|\?)/.test(endpoint);
export const apiIncident=issue=>issue.confirmed===true||(issue.confirmed===undefined&&(!catalogEndpoint(issue.endpoint)||[401,403].includes(issue.httpStatus)));
export function monitoredFetch(store, fetchImpl = fetch) {
  return async (url, options = {}) => {
    const method = options.method || 'GET';
    const parsed = new URL(url);
    const endpoint = method + ' ' + parsed.origin + parsed.pathname.replace(/\/transport-requests\/\d+/g, '/transport-requests/:id');
    const report = (httpStatus, message) => store.recordApiHealth?.({endpoint, method, httpStatus, message: endpoint+' — '+message});
    let response;
    try { response = await fetchImpl(url, options); }
    catch (error) {
      if (!options.signal?.aborted) report(0, 'API недоступен: ошибка сети или тайм-аут.');
      throw error;
    }
    if(store.recordWbResponse){
      const token=(new Headers(options.headers||{}).get('authorization')||'').replace(/^Bearer\s+/i,'');
      let text='',bodyError='';try{text=await response.clone().text();}catch{bodyError='Не удалось полностью прочитать тело ответа.';}
      try{response.archiveId=store.recordWbResponse({requestId:options.archiveRequestId||crypto.randomUUID(),at:new Date().toISOString(),method,url:String(url),httpStatus:response.status,contentType:response.headers.get('content-type')||'',text,bodyError},token);store.recordBotLog?.('wb_response_saved',{responseId:response.archiveId,method,url:String(url),httpStatus:response.status,message:'Ответ WB сохранён до фильтрации.'});}
      catch{try{store.recordBotLog?.('response_archive_failed',{method,httpStatus:response.status,message:'Не удалось сохранить ответ WB. Проверьте доступность и свободное место базы.'});}catch{console.error('WB response archive unavailable.');}}
    }
    report(response.status, response.status === 200 ? 'Работа API восстановлена: HTTP 200.' : `Неожиданный ответ API: HTTP ${response.status}; ожидался HTTP 200.`);
    return response;
  };
}
