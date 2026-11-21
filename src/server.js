import {dashboard} from './dashboard.js';
import { makeDirectoryApi, parseTransport, collectPartnerships, buildDirectory } from './directory-api.js';
import { createCatalogPager } from './catalog-pager.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openStore, AppError, fail, businessDate } from './store.js';
import { BotWorker } from './bot.js';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const loopback = address => ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
function safeEqual(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x,y);
}
async function body(req) {
  if (!(req.headers['content-type'] || '').includes('application/json')) fail(415,'Ожидается JSON.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) fail(413,'Файл слишком большой (максимум 4 МБ).'); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400,'Некорректный JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'Ожидается JSON-объект.');
  return value;
}

export function createPortal({ store, setupToken = '', trustProxy = false, botWorker = null, directoryFetch=fetch, demoMode=false }) {
  const attempts = new Map();
  const catalogPager=createCatalogPager(store,{fetchImpl:directoryFetch});
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Dedicated prefix avoids preview-platform authentication routes; old clients remain supported.
    if(url.pathname.startsWith('/portal-api/'))url.pathname='/api/'+url.pathname.slice('/portal-api/'.length);
    const forwarded=value=>String(value||'').split(',')[0].trim();
    const isSecure = trustProxy && forwarded(req.headers['x-forwarded-proto']) === 'https';
    const publicHost=trustProxy&&req.headers['x-forwarded-host']?forwarded(req.headers['x-forwarded-host']):req.headers.host;
    const origin = `${isSecure ? 'https' : 'http'}://${publicHost}`;
    const token = /(?:^|;\s*)portal_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const framePolicy = demoMode ? '' : " frame-ancestors 'none';";
    const headers = {
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',
      'Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self';${framePolicy} base-uri 'none'; form-action 'self'`,
    };
    const json = (status, data, extra = {}) => { res.writeHead(status, {...headers,'Content-Type':'application/json; charset=utf-8',...extra}); res.end(JSON.stringify(data)); };
    const cookie = value => `portal_session=${value}; HttpOnly; SameSite=${demoMode&&isSecure ? 'None' : 'Lax'}${isSecure ? '; Secure' : ''}; Path=/; Max-Age=${value ? 86400 : 0}`;
    try {
      if (!['GET','POST'].includes(req.method)) fail(405,'Метод не поддерживается.');
      if (req.method === 'POST' && req.headers.origin !== origin) fail(403,'Недопустимый источник запроса.');
      const user = store.session(token);
      if (url.pathname === '/api/session' && req.method === 'GET') return json(200, {
        serverVersion:'0.15.4',user, setupNeeded: store.userCount() === 0, setupTokenRequired: Boolean(setupToken) || trustProxy || !loopback(req.socket.remoteAddress),
        today: businessDate(store.timeZone), timeZone: store.timeZone,
        ...(demoMode ? { demoMode: true } : {}),
      });
      if (url.pathname === '/api/setup' && req.method === 'POST') {
        if (store.userCount()) fail(409,'Первоначальная настройка уже выполнена.');
        if (setupToken ? !safeEqual(req.headers['x-setup-token'],setupToken) : trustProxy || !loopback(req.socket.remoteAddress)) fail(403,'Укажите SETUP_TOKEN на сервере и код первоначальной настройки.');
        const user = store.addUser(await body(req),null,true);
        return json(201,{user},{'Set-Cookie':cookie(store.createSession(user.id))});
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        const attempt = attempts.get(ip);
        if (attempt && attempt.until > Date.now() && attempt.count >= 10) fail(429,'Слишком много попыток. Попробуйте через 15 минут.');
        const input = await body(req);
        try {
          const user = store.login(input.username,input.password);
          attempts.delete(ip); if (token) store.logout(token);
          return json(200,{user},{'Set-Cookie':cookie(store.createSession(user.id))});
        } catch (error) {
          if (!attempt || attempt.until < Date.now()) attempts.set(ip,{count:1,until:Date.now()+900000}); else attempt.count++;
          if (attempts.size > 5000) for (const [key,value] of attempts) if(value.until < Date.now()) attempts.delete(key);
          throw error;
        }
      }
      if (url.pathname.startsWith('/api/')) {
        if (!user) fail(401,'Войдите в портал.');
        if(url.pathname==='/api/bot/test-alert'&&req.method==='POST'){const input=await body(req);return json(201,store.createTestAlert(input.planId??null,user));}
        if(url.pathname==='/api/me/alerts'&&req.method==='GET')return json(200,{data:store.userAlerts(user)});
        const alertMatch=/^\/api\/me\/alerts\/(\d+)\/ack$/.exec(url.pathname);
        if(alertMatch&&req.method==='POST')return json(200,store.acknowledgeAlert(Number(alertMatch[1]),user));
        if(url.pathname==='/api/me/avatar'&&req.method==='POST')return json(200,{user:store.saveAvatar(await body(req),user)});
        const avatarMatch=/^\/api\/users\/(\d+)\/avatar$/.exec(url.pathname);
        if(avatarMatch&&req.method==='GET'){const avatar=store.getAvatar(Number(avatarMatch[1]));res.writeHead(200,{...headers,'Content-Type':avatar.mime});return res.end(avatar.image);}
        if(url.pathname==='/api/bot/public-status' && req.method==='GET') {
          const c=store.botConfig(); const r=store.getBotStatus({role:'admin'});
          return json(200,{enabled:c.enabled,runtime:r.runtime});
        }
        if(url.pathname==='/api/catalog/sync' && req.method==='POST') {
          if(!['admin','super_admin'].includes(user.role))fail(403,'Обновление доступно менеджеру и администратору.');
          const c=store.botConfig();if(!c.token)fail(400,'Сначала сохраните токен в настройках бота.');
          const headers={Authorization:`Bearer ${c.token}`};const api=makeDirectoryApi({logisticsHeaders:headers,driveHeaders:headers});
          try {
            const transport=parseTransport(await api.transport());
            const partners=await collectPartnerships({requestPage:api.partnerships,supplierId:c.supplierId||Number(process.env.SUPPLIER_ID||0)});
            const data=buildDirectory(transport,partners.records);
            const result=store.importDirectory(data,user.id);catalogPager.clear();return json(200,result);
          } catch {fail(502,'Не удалось обновить справочник WB. Проверьте токен и повторите позже.');}
        }
        if (url.pathname === '/api/bot/settings') {
          if(!['admin','super_admin'].includes(user.role))fail(403,'Настройки бота доступны менеджеру и администратору.');
          if(req.method==='GET')return json(200,{settings:store.getBotSettings(user),...store.getBotStatus(user)});
          if(req.method==='POST'){
            const input=await body(req);
            if(demoMode&&input.enabled)fail(400,'Демо не запускает мониторинг. Остановите сервер и запустите npm run dev или npm start.');
            const settings=store.saveBotSettings(input,user);
            botWorker?.changed();
            return json(200,{settings,...store.getBotStatus(user)});
          }
        }
        const deleteEventMatch=/^\/api\/bot\/events\/(\d+)\/delete$/.exec(url.pathname);
        if(deleteEventMatch&&req.method==='POST')return json(200,store.deleteBotEvent(Number(deleteEventMatch[1]),user));
        const attemptMatch=/^\/api\/bot\/attempts\/(\d+)$/.exec(url.pathname);
        if(attemptMatch&&req.method==='GET')return json(200,store.getAcceptanceAttempt(Number(attemptMatch[1]),user));
        const snapshotMatch=/^\/api\/bot\/snapshots\/(\d+)$/.exec(url.pathname);
        if(snapshotMatch&&req.method==='GET')return json(200,store.getBotSnapshot(Number(snapshotMatch[1]),user));
        if (url.pathname === '/api/bot/status' && req.method === 'GET') {
          if(!['admin','super_admin'].includes(user.role))fail(403,'Состояние бота доступно менеджеру и администратору.');
          return json(200,{settings:store.getBotSettings(user),...store.getBotStatus(user)});
        }
        if (url.pathname === '/api/logout' && req.method === 'POST') { store.logout(token); return json(200,{ok:true},{'Set-Cookie':cookie('')}); }
        if(url.pathname==='/api/dashboard'&&req.method==='GET')return json(200,dashboard(store,user));
        if(url.pathname==='/api/catalog/summary'&&req.method==='GET')return json(200,store.catalogSummary());
        if(url.pathname==='/api/catalog/page'&&req.method==='GET')return json(200,await catalogPager.page({kind:url.searchParams.get('kind'),query:url.searchParams.get('query')||'',cursor:url.searchParams.get('cursor')||null}));
        if (url.pathname === '/api/catalog' && req.method === 'GET') return json(200,store.catalog());
        if (url.pathname === '/api/requests' && req.method === 'GET') return json(200,{data:store.requests(user)});
        if (url.pathname === '/api/requests' && req.method === 'POST') return json(201,{data:store.saveRequest(await body(req),user)});
        const watchMatch=/^\/api\/requests\/(\d+)\/watch$/.exec(url.pathname);
        if(watchMatch&&req.method==='POST'){const input=await body(req);return json(200,store.watchRequest(Number(watchMatch[1]),input.enabled,user));}
        const match = /^\/api\/requests\/(\d+)(\/status)?$/.exec(url.pathname);
        if (match && req.method === 'POST') {
          const input = await body(req);
          return json(200,{data:match[2] ? store.changeStatus(Number(match[1]),input.status,input.version,user) : store.saveRequest(input,user,Number(match[1]))});
        }
        if (url.pathname === '/api/activity' && req.method === 'GET') {if(user.role==='logist')fail(403,'История доступна менеджеру и администратору.');return json(200,{data:store.activity()});}
        if (url.pathname === '/api/users' && req.method === 'GET') return json(200,{data:store.users()});
        const userMatch=/^\/api\/users\/(\d+)$/.exec(url.pathname);
        if(userMatch&&req.method==='POST')return json(200,{user:store.updateUser(Number(userMatch[1]),await body(req),user)});
        if (url.pathname === '/api/users' && req.method === 'POST') return json(201,{data:store.addUser(await body(req),user)});
        if (url.pathname === '/api/catalog/import' && req.method === 'POST' && ['admin','super_admin'].includes(user.role)) {const result=store.importDirectory(await body(req),user.id);catalogPager.clear();return json(200,result);}
        fail(404,'Раздел не найден или недостаточно прав.');
      }
      if (req.method !== 'GET') fail(404,'Страница не найдена.');
      const files = { '/':'index.html','/paged-list.js':'paged-list.js','/overview.js':'overview.js','/app.js':'app.js','/styles.css':'styles.css','/design.css':'design.css','/vendor/tabulator/tabulator.min.js':'vendor/tabulator/tabulator.min.js','/vendor/tabulator/tabulator.min.css':'vendor/tabulator/tabulator.min.css','/favicon.svg':'favicon.svg' };
      const preset=/^\/avatars\/(cat|frog|robot|bear|owl)\.svg$/.test(url.pathname);
      const file = preset?url.pathname.slice(1):files[url.pathname];
      if (!file) fail(404,'Страница не найдена.');
      const mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
      res.writeHead(200,{...headers,'Content-Type':`${mime}; charset=utf-8`}); res.end(await readFile(resolve(publicDir,file)));
    } catch (error) {
      if (!(error instanceof AppError)) console.error('Portal request failed:', error.code || error.name);
      if (!res.headersSent) json(error.status || 500,{error:error instanceof AppError ? error.message : 'Не удалось выполнить операцию. Повторите попытку.'});
      else res.end();
    }
  });
}

export function seedPreviewDemo(store) {
  if (store.userCount() > 0) return;
  const admin = store.addUser({ username: 'admin', name: 'Алексей Соколов', password: 'logist2026demo' }, null, true);
  const manager = store.addUser({ username: 'elena.k', name: 'Елена Кузнецова', password: 'logist2026demo', role: 'admin' }, admin);
  const logist = store.addUser({ username: 'dmitry.v', name: 'Дмитрий Волков', password: 'logist2026demo', role: 'logist' }, admin);
  store.saveAvatar({ preset: 'owl' }, admin);
  store.saveAvatar({ preset: 'cat' }, manager);
  store.saveAvatar({ preset: 'robot' }, logist);

  store.importDirectory({
    transport: {
      drivers: [
        { id: 481204, name: 'Морозов Сергей Викторович' },
        { id: 481219, name: 'Громов Андрей Николаевич' },
        { id: 481245, name: 'Белов Павел Александрович' },
        { id: 481288, name: 'Тарасов Максим Игоревич' },
        { id: 481302, name: 'Ковалёв Олег Дмитриевич' },
        { id: 481340, name: 'Савельев Игорь Сергеевич' },
        { id: 481377, name: 'Фёдоров Виктор Петрович' },
      ],
      vehicles: [
        { id: 90211, name: 'SITRAK C7H 4x2', number_plate: 'А412КМ196' },
        { id: 90218, name: 'Volvo FH 460', number_plate: 'Е804УХ196' },
        { id: 90225, name: 'SCANIA R440', number_plate: 'К195МТ196' },
        { id: 90239, name: 'KAMAZ-54901 Neo', number_plate: 'М730ОР196' },
        { id: 90244, name: 'Mercedes-Benz Actros', number_plate: 'Н218АВ196' },
        { id: 90257, name: 'DAF XF 105.460', number_plate: 'О562СЕ196' },
      ],
      trailers: [
        { id: 70411, name: 'Schmitz Cargobull 92 м³', number_plate: 'АВ481266' },
        { id: 70419, name: 'Krone Profi Liner', number_plate: 'АЕ903466' },
        { id: 70426, name: 'Kögel Cargo 86 м³', number_plate: 'АК217566' },
        { id: 70438, name: 'Wielton Curtain Master', number_plate: 'АМ664066' },
      ],
    },
  }, admin.id);

  const today = businessDate(store.timeZone);
  const addDays = (iso, days) => {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  store.saveRequest({ routeId: 61373, serviceDate: today, priority: 1, driverId: 481204, vehicleId: 90211, trailerId: 70411, note: 'Коледино → Екатеринбург, срочная подача' }, admin);
  store.saveRequest({ routeId: 61373, serviceDate: today, priority: 2, driverId: 481219, vehicleId: 90218, trailerId: 70419, note: 'Резервный экипаж на вечернее окно' }, logist);
  store.saveRequest({ routeId: 65522, serviceDate: addDays(today, 1), priority: 1, driverId: 481245, vehicleId: 90225, trailerId: 70426, note: 'Казань → Новосибирск, 86 м³' }, manager);
  const pausedReq = store.saveRequest({ routeId: 64197, serviceDate: addDays(today, 1), priority: 1, driverId: 481288, vehicleId: 90239, trailerId: null, note: 'Ожидаем подтверждение отгрузки на СЦ' }, logist);
  store.changeStatus(pausedReq.id, 'paused', pausedReq.version, manager);
  store.saveRequest({ routeId: 66091, serviceDate: addDays(today, 2), priority: 1, driverId: 481302, vehicleId: 90244, trailerId: 70438, note: 'Подольск → Тюмень, без догруза' }, admin);
  const archivedReq = store.saveRequest({ routeId: 61373, serviceDate: today, priority: 3, driverId: 481340, vehicleId: 90257, trailerId: null, note: 'Рейс выполнен в прошлой смене' }, logist);
  store.changeStatus(archivedReq.id, 'archived', archivedReq.version, admin);

  store.recordBotLog('poll_started', { routes: [61373, 65522, 66091], intervalSeconds: 30 });
  store.recordBotLog('response_received', { routeId: 61373, httpStatus: 200, durationMs: 142 });
  store.recordBotLog('poll_completed', { routes: [61373, 65522, 66091], candidates: 2, newEvents: 1 });
  store.recordBotCandidates([
    {
      id: 8941205,
      routeId: 61373,
      carDt: new Date(Date.now() + 6 * 3600000).toISOString(),
      curl: 'curl --request PUT "https://logistics.wb.ru/transport-requests-service/api/v1/transport-requests/8941205/take-by-supplier" --header "Authorization: Bearer $WB_TOKEN" --header "Content-Type: application/json" --data-raw \'{"vehicle":90211,"driver":481204,"freelancerID":null,"accept_round_trip":false}\'',
    },
  ], { response: { data: [{ transport_request_id: 8941205, route_id: 61373, status: 'created' }] } });
}

export async function startPortal() {
  const store = openStore(resolve(process.env.DATABASE_FILE || (process.env.DEMO_SEED === '1'?'./data/demo.sqlite':'./data/portal.sqlite')),{timeZone:process.env.PORTAL_TIMEZONE || 'Asia/Yekaterinburg'});
  if (process.env.DEMO_SEED === '1') {
    seedPreviewDemo(store);
    store.stopBot('Демонстрационный режим: мониторинг отключён.');
  }
  if (process.env.DIRECTORY_FILE && !store.catalog().importedAt) {
    try { const counts = store.importDirectory(JSON.parse((await readFile(process.env.DIRECTORY_FILE,'utf8')).replace(/^\uFEFF/,''))); console.log('Imported directory:',counts); }
    catch { console.error('Could not import DIRECTORY_FILE. Import directory.json in the portal.'); }
  }
  const botWorker=new BotWorker(store);
  const server = createPortal({store,setupToken:process.env.SETUP_TOKEN,trustProxy:process.env.TRUST_PROXY === '1',botWorker,demoMode:process.env.DEMO_SEED === '1'});
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '0.0.0.0';
  server.listen(port,host,() => {console.log(`Local: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);if(process.env.DEMO_SEED !== '1')botWorker.start();else console.log('DEMO: monitoring disabled. Use npm run dev for the real worker.');});
  server.on('error',error => {console.error('Server error:',error.code);store.close();process.exitCode=1;});
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => {botWorker.stop();server.close(() => {store.close();process.exit(0);});});
  return {server,store,botWorker};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startPortal();
