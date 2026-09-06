import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';

import { openDatabase, getConfig, scheduleBackups } from './db.js';
import { createApi } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const accessCode = process.env.ACCESS_CODE;

if (!accessCode || accessCode.length < 4) {
  console.error(
    'ACCESS_CODE manquant ou trop court. Définissez-le dans .env (au moins 4 caractères).',
  );
  process.exit(1);
}

const db = openDatabase();
// Le secret de signature du cookie est généré au premier démarrage et persisté
// en base : ACCESS_CODE reste la seule variable d'environnement obligatoire.
const cookieSecret = getConfig(db, 'cookie_secret');
// Derrière un proxy TLS, le cookie doit être `secure`. En HTTP simple (réseau
// local, test), il faut pouvoir le désactiver, sinon plus personne ne se connecte.
const secure = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser(cookieSecret));

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', createApi(db, { accessCode, secure }));
app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));

scheduleBackups(db, path.join(path.dirname(process.env.DB_PATH || './data/challenge.sqlite'), 'backups'));

const server = app.listen(PORT, HOST, () => {
  console.log(`Challenge en écoute sur http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
