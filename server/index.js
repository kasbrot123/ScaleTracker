import path from 'node:path';
import { createApp } from './app.js';
import { seedDemo } from './seed.js';
import { openStore } from './store.js';

const password = process.env.APP_PASSWORD;
if (!password || password.length < 8) {
  console.error('APP_PASSWORD muss gesetzt sein und mindestens 8 Zeichen haben.');
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const dbFile = process.env.DB_PATH ?? path.resolve('data', 'gewicht.db');
const store = openStore(dbFile);

if (process.env.SEED_DEMO !== 'false') {
  const seeded = seedDemo(store);
  if (seeded) console.log(`${seeded} Demo-Messungen angelegt.`);
}

const app = createApp({ store, password, cookieSecure: process.env.COOKIE_SECURE === 'true' });
const server = app.listen(port, () => console.log(`ScaleTracker läuft auf Port ${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
}
