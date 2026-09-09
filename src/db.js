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
  // Malus : une sanction saisie à la main, au plus une par joueur et par
  // semaine — la clé primaire le garantit, comme pour les pesées. Le diviseur
  // n'est pas contraint à une liste ici : le barème ignore ce qu'il ne connaît
  // pas (cf. MALUS_DIVISORS), et une liste en dur dans un CHECK obligerait une
  // migration pour ajouter un ÷5.
  `
  CREATE TABLE penalty (
    player_id  TEXT NOT NULL REFERENCES player(id),
    week_start TEXT NOT NULL CHECK (week_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    divisor    INTEGER NOT NULL CHECK (divisor > 1),
    reason     TEXT NOT NULL,
    author     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (player_id, week_start)
  );
  `,
  // Un nombre libre de joueurs. La contrainte `id IN ('a','b')` de la migration
  // 1 doit donc sauter, et SQLite ne sait pas retirer un CHECK autrement qu'en
  // reconstruisant la table — que quatre tables référencent en clé étrangère.
  // C'est migrate() qui coupe `foreign_keys` le temps des migrations, et qui
  // repasse `foreign_key_check` derrière : le faire ici serait sans effet,
  // chaque étape tournant déjà dans un BEGIN.
  //
  // `joined_week` et `archived_week` sont des lundis, ou NULL : « depuis le
  // début » et « toujours en jeu ». Des dates plutôt que des numéros de
  // semaine, qui bougeraient si la date de départ du challenge changeait.
  `
  CREATE TABLE player_v2 (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    joined_week   TEXT CHECK (joined_week IS NULL OR joined_week GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    archived_week TEXT CHECK (archived_week IS NULL OR archived_week GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at    TEXT NOT NULL
  );

  INSERT INTO player_v2 (id, name, joined_week, archived_week, created_at)
  SELECT id, name, NULL, NULL, '' FROM player;

  DROP TABLE player;
  ALTER TABLE player_v2 RENAME TO player;
  `,
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= MIGRATIONS.length) return;

  // SQLite ne sait pas retirer une contrainte : il faut reconstruire la table,
  // donc la déposer et la recréer sous son nom — et entre les deux, les lignes
  // filles pointent dans le vide. `foreign_keys` ne se change qu'EN DEHORS
  // d'une transaction (dedans le PRAGMA est ignoré en silence, et le COMMIT
  // échoue), c'est pourquoi il est coupé ici et pas dans le SQL d'une étape.
  //
  // Ce n'est pas un blanc-seing : `foreign_key_check` relit toute la base
  // ensuite, et une migration qui aurait laissé une ligne orpheline échoue
  // bruyamment plutôt que de démarrer sur une base incohérente.
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      const step = MIGRATIONS[v];
      db.transaction(() => {
        db.exec(step);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
    const orphans = db.pragma('foreign_key_check');
    if (orphans.length > 0) {
      throw new Error(
        `Migration interrompue : ${orphans.length} ligne(s) orpheline(s) `
        + `(${orphans.slice(0, 3).map((o) => `${o.table}#${o.rowid}`).join(', ')}). `
        + 'La base n\'a pas été modifiée au-delà de la dernière étape réussie.',
      );
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seed(db) {
  const players = db.prepare('SELECT COUNT(*) AS n FROM player').get().n;
  if (players === 0) {
    // Deux joueurs au départ, mais rien n'y oblige : on en ajoute et on en
    // archive depuis les réglages. `joined_week` à NULL = depuis le début.
    const ins = db.prepare(
      'INSERT INTO player (id, name, joined_week, archived_week, created_at) VALUES (?, ?, NULL, NULL, ?)',
    );
    const t = new Date().toISOString();
    db.transaction(() => {
      ins.run('a', 'Joueur 1', t);
      ins.run('b', 'Joueur 2', t);
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
