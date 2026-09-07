/**
 * Connexion SQLite, migrations et sauvegardes.
 *
 * Une seule base, un seul process Node, et better-sqlite3 est synchrone : il
 * n'y a aucune concurrence d'écriture à gérer. Les écritures multi-instructions
 * passent quand même par `db.transaction()`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { mondayOf, todayParis } from './dates.js';

/**
 * Migrations appliquées dans l'ordre, pilotées par `PRAGMA user_version`.
 * On n'édite JAMAIS une migration déjà livrée : on en ajoute une à la suite.
 */
const MIGRATIONS = [
  `
  CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE player (
    id   TEXT PRIMARY KEY CHECK (id IN ('a','b')),
    name TEXT NOT NULL
  );

  CREATE TABLE session (
    id         INTEGER PRIMARY KEY,
    player_id  TEXT NOT NULL REFERENCES player(id),
    date       TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    discipline TEXT NOT NULL CHECK (discipline IN ('course','marche','velo')),
    duration_s INTEGER NOT NULL CHECK (duration_s > 0 AND duration_s <= 36000),
    author     TEXT NOT NULL,
    client_id  TEXT UNIQUE,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX session_pd ON session(player_id, date);

  CREATE TABLE pushup (
    id         INTEGER PRIMARY KEY,
    player_id  TEXT NOT NULL REFERENCES player(id),
    date       TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    count      INTEGER NOT NULL CHECK (count > 0 AND count <= 2000),
    author     TEXT NOT NULL,
    client_id  TEXT UNIQUE,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX pushup_pd ON pushup(player_id, date);

  CREATE TABLE weigh_in (
    player_id   TEXT NOT NULL REFERENCES player(id),
    week_start  TEXT NOT NULL CHECK (week_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    grams       INTEGER NOT NULL CHECK (grams BETWEEN 30000 AND 400000),
    measured_on TEXT NOT NULL,
    author      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (player_id, week_start)
  );
  `,
  // On ne saisit plus un poids mais la PERTE de la semaine : c'est le chiffre
  // que le barème note. Les pesées déjà enregistrées sont converties en écarts
  // par rapport à la pesée antérieure la plus proche — exactement le calcul que
  // faisait api.js à la lecture, donc aucun point ne bouge. La première pesée
  // de chaque joueur ne se comparait à rien : elle devient une perte de 0.
  //
  // La contrainte reste large ici (n'importe quel écart entre 30 et 400 kg
  // était représentable) ; c'est api.js qui borne la saisie à ±50 kg, avec un
  // message lisible.
  `
  CREATE TABLE weigh_in_v2 (
    player_id   TEXT NOT NULL REFERENCES player(id),
    week_start  TEXT NOT NULL CHECK (week_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    loss_grams  INTEGER NOT NULL CHECK (loss_grams BETWEEN -400000 AND 400000),
    measured_on TEXT NOT NULL,
    author      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (player_id, week_start)
  );

  INSERT INTO weigh_in_v2 (player_id, week_start, loss_grams, measured_on, author, created_at, updated_at)
  SELECT w.player_id, w.week_start,
         COALESCE(
           (SELECT prev.grams FROM weigh_in prev
             WHERE prev.player_id = w.player_id AND prev.week_start < w.week_start
             ORDER BY prev.week_start DESC LIMIT 1),
           w.grams
         ) - w.grams,
         w.measured_on, w.author, w.created_at, w.updated_at
    FROM weigh_in w;

  DROP TABLE weigh_in;
  ALTER TABLE weigh_in_v2 RENAME TO weigh_in;
  `,
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    const step = MIGRATIONS[v];
    db.transaction(() => {
      db.exec(step);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

function seed(db) {
  const players = db.prepare('SELECT COUNT(*) AS n FROM player').get().n;
  if (players === 0) {
    const ins = db.prepare('INSERT INTO player (id, name) VALUES (?, ?)');
    db.transaction(() => {
      ins.run('a', 'Joueur 1');
      ins.run('b', 'Joueur 2');
    })();
  }
  // Par défaut, le challenge démarre le lundi de la semaine en cours.
  setConfigDefault(db, 'start_date', mondayOf(todayParis()));
  setConfigDefault(db, 'weeks_total', '4');
  // Généré ici plutôt que réclamé en variable d'environnement : ACCESS_CODE
  // reste ainsi la seule variable obligatoire pour déployer.
  setConfigDefault(db, 'cookie_secret', crypto.randomBytes(32).toString('hex'));
}

function setConfigDefault(db, key, value) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
    .run(key, value);
}

export function getConfig(db, key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setConfig(db, key, value) {
  db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function openDatabase(file = process.env.DB_PATH || './data/challenge.sqlite') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);

  // WAL crée `-wal` et `-shm` à côté du fichier : c'est pourquoi le volume
  // Docker doit monter le RÉPERTOIRE, jamais le fichier seul.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  seed(db);
  return db;
}

/**
 * Sauvegarde quotidienne. On n'utilise jamais `cp` sur une base WAL vivante :
 * `db.backup()` est la seule méthode sûre à chaud.
 */
export function scheduleBackups(db, dir, { keep = 14, everyMs = 24 * 3600 * 1000 } = {}) {
  const run = async () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      await db.backup(path.join(dir, `challenge-${todayParis()}.sqlite`));
      const old = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('challenge-') && f.endsWith('.sqlite'))
        .sort()
        .slice(0, -keep);
      for (const f of old) fs.unlinkSync(path.join(dir, f));
    } catch (err) {
      console.error('[backup] échec :', err.message);
    }
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return timer;
}
