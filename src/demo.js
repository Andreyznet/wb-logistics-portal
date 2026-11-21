process.env.DEMO_SEED='1';
process.env.DATABASE_FILE=process.env.DEMO_DATABASE_FILE||'./data/preview.sqlite';
process.env.PORT||='3000';
process.env.HOST||='127.0.0.1';
const {startPortal}=await import('./server.js');
await startPortal();
