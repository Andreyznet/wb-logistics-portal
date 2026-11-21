// Portable demo launcher: Node handles environment variables on Windows and Unix.
process.env.DEMO_SEED='1';
process.env.DATABASE_FILE=process.env.DEMO_DATABASE_FILE||'./data/demo.sqlite';
process.env.PORT||='3000';
process.env.HOST||='0.0.0.0';
const {startPortal}=await import('./server.js');
await startPortal();
