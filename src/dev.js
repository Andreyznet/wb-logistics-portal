// Development runs the real worker; demonstration is an explicit separate command.
import {existsSync} from 'node:fs';
delete process.env.DEMO_SEED;
// Previous dev versions stored user settings in this file. Reuse it only when
// the configured working database does not exist, without moving or overwriting files.
const target=process.env.DATABASE_FILE||'./data/portal.sqlite';
const legacy=process.env.DEMO_DATABASE_FILE||'./data/demo.sqlite';
if(!existsSync(target)&&existsSync(legacy)){
 process.env.DATABASE_FILE=legacy;
 console.log('Using existing database from previous dev version: '+legacy);
}else process.env.DATABASE_FILE=target;
const {startPortal}=await import('./server.js');
await startPortal();
