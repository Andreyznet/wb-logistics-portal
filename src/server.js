import { makeDirectoryApi, parseTransport, collectPartnerships, buildDirectory } from './directory-api.js';
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

export function createPortal({ store, setupToken = '', trustProxy = false, botWorker = null }) {
  const attempts = new Map();
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const isSecure = trustProxy && req.headers['x-forwarded-proto'] === 'https';
    const origin = `${isSecure ? 'https' : 'http'}://${req.headers.host}`;
    const token = /(?:^|;\s*)portal_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const headers = {
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    };
    const json = (status, data, extra = {}) => { res.writeHead(status, {...headers,'Content-Type':'application/json; charset=utf-8',...extra}); res.end(JSON.stringify(data)); };
    const cookie = value => `portal_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${value ? 86400 : 0}${isSecure ? '; Secure' : ''}`;
    try {
      if (!['GET','POST'].includes(req.method)) fail(405,'Метод не поддерживается.');
      if (req.method === 'POST' && req.headers.origin !== origin) fail(403,'Недопустимый источник запроса.');
      const user = store.session(token);
      if (url.pathname === '/api/session' && req.method === 'GET') return json(200, {
        serverVersion:'0.10.3',user, setupNeeded: store.userCount() === 0, setupTokenRequired: Boolean(setupToken) || trustProxy || !loopback(req.socket.remoteAddress),
        today: businessDate(store.timeZone), timeZone: store.timeZone,
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
            const partners=await collectPartnerships({requestPage:api.partnerships,supplierId:Number(process.env.SUPPLIER_ID||10095401)});
            const data=buildDirectory(transport,partners.records);
            return json(200,store.importDirectory(data,user.id));
          } catch {fail(502,'Не удалось обновить справочник WB. Проверьте токен и повторите позже.');}
        }
        if (url.pathname === '/api/bot/settings') {
          if(!['admin','super_admin'].includes(user.role))fail(403,'Настройки бота доступны менеджеру и администратору.');
          if(req.method==='GET')return json(200,{settings:store.getBotSettings(user),...store.getBotStatus(user)});
          if(req.method==='POST'){
            const settings=store.saveBotSettings(await body(req),user);
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
        if (url.pathname === '/api/catalog' && req.method === 'GET') return json(200,store.catalog());
        if (url.pathname === '/api/requests' && req.method === 'GET') return json(200,{data:store.requests()});
        if (url.pathname === '/api/requests' && req.method === 'POST') return json(201,{data:store.saveRequest(await body(req),user)});
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
        if (url.pathname === '/api/catalog/import' && req.method === 'POST' && ['admin','super_admin'].includes(user.role)) return json(200,store.importDirectory(await body(req),user.id));
        fail(404,'Раздел не найден или недостаточно прав.');
      }
      if (req.method !== 'GET') fail(404,'Страница не найдена.');
      const files = { '/':'index.html','/app.js':'app.js','/styles.css':'styles.css','/vendor/tabulator/tabulator.min.js':'vendor/tabulator/tabulator.min.js','/vendor/tabulator/tabulator.min.css':'vendor/tabulator/tabulator.min.css','/favicon.svg':'favicon.svg' };
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = openStore(resolve(process.env.DATABASE_FILE || './data/portal.sqlite'),{timeZone:process.env.PORTAL_TIMEZONE || 'Asia/Yekaterinburg'});
  if (process.env.DIRECTORY_FILE && !store.catalog().importedAt) {
    try { const counts = store.importDirectory(JSON.parse((await readFile(process.env.DIRECTORY_FILE,'utf8')).replace(/^\uFEFF/,''))); console.log('Imported directory:',counts); }
    catch { console.error('Could not import DIRECTORY_FILE. Import directory.json in the portal.'); }
  }
  const botWorker=new BotWorker(store);
  const server = createPortal({store,setupToken:process.env.SETUP_TOKEN,trustProxy:process.env.TRUST_PROXY === '1',botWorker});
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1';
  server.listen(port,host,() => {console.log(`Local: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);botWorker.start();});
  server.on('error',error => {console.error('Server error:',error.code);store.close();process.exitCode=1;});
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => {botWorker.stop();server.close(() => {store.close();process.exit(0);});});
}

