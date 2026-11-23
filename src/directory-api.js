import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
class ApiError extends Error { constructor(message,extra={}) {super(message);Object.assign(this,extra);} }

export const TRANSPORT_URL = 'https://logistics.wb.ru/suppliers-service/api/v1/suppliers/transport';
export const PARTNERSHIPS_URL = 'https://drive.wb.ru/user-management/api/v1/public/user-partnerships/drivers/list';

export function partnershipBody(supplierId, token = null) {
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) throw new Error('SUPPLIER_ID must be a positive integer');
  return {
    data: { is_rental_enabled: null, supplier_id: supplierId },
    meta: { page_size: 30, page_token: token },
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function recordKey(row) { return createHash('sha256').update(JSON.stringify(stable(row))).digest('hex'); }

export function parsePartnershipPage(payload) {
  if (payload?.success !== true || !Array.isArray(payload.data) || !payload.meta ||
      typeof payload.meta !== 'object' || Array.isArray(payload.meta)) throw new Error('Invalid partnerships response');
  if (payload.data.length > 30) throw new Error('Partnership page exceeded page_size=30');
  const token = payload.meta.next_page_token;
  if (token != null && typeof token !== 'string') throw new Error('Invalid partnership next_page_token');
  const keys = new Set();
  for (const row of payload.data) {
    if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.status !== 'string' || !row.status ||
        !(row.um_uuid == null || typeof row.um_uuid === 'string')) throw new Error('Invalid driver partnership record');
    const key = recordKey(row);
    if (keys.has(key)) throw new Error('Exact duplicate partnership record within page');
    keys.add(key);
  }
  return { rows: payload.data, nextToken: token || null };
}

export function parseTransport(payload) {
  const data = payload?.data;
  if (!data || typeof data !== 'object' || payload.error || payload.success === false) throw new Error('Invalid transport response');
  for (const name of ['drivers', 'vehicles', 'trailers']) {
    if (!Array.isArray(data[name])) throw new Error(`Invalid transport collection: ${name}`);
    const ids = new Set();
    for (const row of data[name]) {
      if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id)) throw new Error(`Invalid or duplicate transport ID in ${name}`);
      ids.add(row.id);
    }
  }
  const vehicleIds = new Set(data.vehicles.map(row => row.id));
  if (data.trailers.some(row => vehicleIds.has(row.id))) throw new Error('Transport ID occurs as both vehicle and trailer');
  return data;
}

export function makeDirectoryApi({ logisticsHeaders, driveHeaders }, fetchImpl = fetch) {
  async function request(url, headers, body, attempt=0) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new ApiError('Directory request failed or timed out; export not completed'); }
    // These endpoints only read directories/search results, including their POST forms.
    if([502,503,504].includes(response.status)&&attempt===0){try{await response.body?.cancel();}catch{}await sleep(300);return request(url,headers,body,1);}
    if (!response.ok) throw new ApiError(`Directory API returned HTTP ${response.status}; export stopped`, { status: response.status, stop: true });
    if (!(response.headers.get('content-type') || '').includes('json')) throw new ApiError('Directory API returned non-JSON; export stopped', { stop: true });
    try { return await response.json(); } catch { throw new Error('Directory API returned invalid JSON'); }
  }
  return {
    transport: () => request(TRANSPORT_URL, logisticsHeaders),
    routecars: body => request(ROUTECARS_URL, logisticsHeaders, body),
    partnerships: body => request(PARTNERSHIPS_URL, driveHeaders, body),
  };
}

export async function collectPartnerships({ requestPage, supplierId, onPage = () => {}, pause = () => sleep(1000), maxPages = 1000 }) {
  const records = [];
  const seenRecords = new Set();
  const seenTokens = new Set();
  let token = null;
  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await pause();
    const parsed = parsePartnershipPage(await requestPage(partnershipBody(supplierId, token)));
    for (const row of parsed.rows) {
      const key = recordKey(row);
      if (seenRecords.has(key)) throw new Error('Exact partnership record repeated across pages; export stopped');
      seenRecords.add(key);
      records.push(row); // Numeric driver ID alone is not a unique partnership record key.
    }
    onPage({ page, received: parsed.rows.length, collectedRecords: records.length, hasNext: Boolean(parsed.nextToken) });
    if (!parsed.nextToken) return { records, pages: page, reached_end_of_pagination: true };
    if (!parsed.rows.length || seenTokens.has(parsed.nextToken)) throw new Error('Partnership pagination made no progress or repeated its cursor');
    seenTokens.add(parsed.nextToken);
    token = parsed.nextToken;
  }
  throw new Error('Maximum partnership page count exceeded');
}

export function buildDirectory(transport, partnerships, info = {}) {
  const byId = new Map();
  for (const row of partnerships) {
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  const transportIds = new Set(transport.drivers.map(row => row.id));
  const statuses = Object.create(null);
  for (const row of partnerships) statuses[row.status] = (statuses[row.status] || 0) + 1;
  return {
    transport,
    partnerships,
    drivers: transport.drivers.map(row => ({ ...row, partnerships: byId.get(row.id) || [] })),
    partnerships_without_transport_driver: partnerships.filter(row => !transportIds.has(row.id)),
    export_info: {
      ...info, transport_driver_count: transport.drivers.length, vehicle_count: transport.vehicles.length,
      trailer_count: transport.trailers.length, partnership_record_count: partnerships.length,
      unique_partnership_driver_count: byId.size, status_counts: statuses,
      driver_ids_with_multiple_records: [...byId.values()].filter(rows => rows.length > 1).length,
      partnership_total_count_available: false, availability_for_trip_verified: false,
    },
  };
}


export const ROUTECARS_URL='https://logistics.wb.ru/router-bff/routecar/v1/routecars';
export function routecarBody(query,token=''){
 return {data:{query,delivery_types:['DELIVERY_TYPE_MGT']},meta:{page_size:400,page_token:token}};
}
export function parseRoutecarPage(payload){
 const rows=payload?.data?.routecars,meta=payload?.meta;
 if(payload?.success===false||payload?.error||!Array.isArray(rows)||rows.length>400||typeof meta?.has_next!=='boolean')throw new Error('Invalid routecars response');
 const ids=new Set();const normalized=rows.map(row=>{
  if(!/^[1-9]\d*$/.test(String(row?.routecar_id)))throw new Error('Invalid route ID');
  const id=Number(row.routecar_id),name=row.routecar_name;
  if(!Number.isSafeInteger(id)||id>2147483647||ids.has(id)||typeof name!=='string'||!name.trim()||name.length>500)throw new Error('Invalid route record');
  ids.add(id);return {id,name:name.trim()};
 });
 if(meta.has_next&&(!rows.length||typeof meta.page_token!=='string'||!meta.page_token||meta.page_token.length>2000))throw new Error('Invalid route cursor');
 return {rows:normalized,nextToken:meta.has_next?meta.page_token:null};
}
