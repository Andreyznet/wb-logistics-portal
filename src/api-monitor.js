// Observe real requests only; never probe or retry a mutating endpoint.
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
    report(response.status, response.status === 200 ? 'Работа API восстановлена: HTTP 200.' : `Неожиданный ответ API: HTTP ${response.status}; ожидался HTTP 200.`);
    return response;
  };
}
