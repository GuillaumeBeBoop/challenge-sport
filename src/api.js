/**
 * Routes JSON.
 *
 * Deux conventions qui gardent le front trivial :
 *   1. `/api/state` renvoie le RAISONNEMENT, pas seulement le chiffre. Sans ça
 *      le front finirait par réimplémenter les règles pour les expliquer.
 *   2. Chaque mutation renvoie le `/api/state` frais de la semaine concernée.
 *      Plus besoin d'UI optimiste, et le score affiché est toujours l'avis du
 *      serveur.
 *
 * Le serveur est la seule autorité de validation ; le front pré-valide pour le
 * confort, jamais pour la sûreté.
 */

import crypto from 'node:crypto';
import express from 'express';

import { getConfig, setConfig } from './db.js';
import { scoreWeek, CAPS } from './scoring.js';
import { defiForWeek, DEFIS } from './defis.js';
import {
  addDays, isDate, isMonday, mondayOf, todayParis,
  weekNumber, weekRange, weekStartOf,
} from './dates.js';

const PLAYERS = ['a', 'b'];
const DISCIPLINES = ['course', 'marche', 'velo'];
const COOKIE = 'challenge_auth';
const COOKIE_MAX_AGE = 180 * 24 * 3600 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function readPlayer(v) {
  if (!PLAYERS.includes(v)) throw bad('Joueur inconnu.');
  return v;
}

function readInt(v, { min, max, label }) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n)) throw bad(`${label} doit être un nombre entier.`);
  if (n < min || n > max) throw bad(`${label} doit être compris entre ${min} et ${max}.`);
  return n;
}

/** Une date de saisie : dans le challenge, et pas dans le futur. */
function readDate(v, startDate) {
  if (!isDate(v)) throw bad('Date invalide.');
  if (v < startDate) throw bad(`Cette date précède le début du challenge (${startDate}).`);
  // Un jour de tolérance : sinon une faute de frappe sur l'année crée une
  // semaine 4000, et un joueur en décalage horaire se ferait refuser sa séance.
  const limit = addDays(todayParis(), 1);
  if (v > limit) throw bad('Cette date est dans le futur.');
  return v;
}

function readName(v, fallback) {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim().slice(0, 40);
  return s || fallback;
}

/* ------------------------------------------------------------------ *
 * Lecture et notation
 * ------------------------------------------------------------------ */

function readSettings(db) {
  return {
    startDate: getConfig(db, 'start_date'),
    weeksTotal: Number(getConfig(db, 'weeks_total')) || 4,
    players: db.prepare('SELECT id, name FROM player ORDER BY id').all(),
  };
}

function loadRows(db) {
  return {
    sessions: db
      .prepare(
        `SELECT id, player_id, date, discipline, duration_s, author, created_at
           FROM session WHERE deleted_at IS NULL ORDER BY date, id`,
      )
      .all(),
    pushups: db
      .prepare(
        `SELECT id, player_id, date, count, author, created_at
           FROM pushup WHERE deleted_at IS NULL ORDER BY date, id`,
      )
      .all(),
    weighIns: db
      .prepare(
        `SELECT player_id, week_start, loss_grams, measured_on, author, updated_at
           FROM weigh_in ORDER BY week_start`,
      )
      .all(),
  };
}

/**
 * Note tout le challenge d'un coup. Les points ne sont jamais stockés : on
 * recharge les lignes brutes et on recalcule. À cette échelle (quelques
 * milliers de lignes), c'est instantané, et une pesée corrigée en semaine 3
 * répare automatiquement toutes les semaines suivantes.
 */
function computeAll(db) {
  const { startDate, weeksTotal, players } = readSettings(db);
  const rows = loadRows(db);
  const today = todayParis();

  const weekOf = (date) => weekNumber(date, startDate);
  let maxWeek = Math.max(weeksTotal, weekOf(today));
  for (const r of [...rows.sessions, ...rows.pushups]) maxWeek = Math.max(maxWeek, weekOf(r.date));
  if (!Number.isFinite(maxWeek) || maxWeek < 1) maxWeek = 1;

  const weeks = [];
  const cumulative = { a: 0, b: 0 };

  for (let n = 1; n <= maxWeek; n++) {
    const { from, to } = weekRange(n, startDate);
    const inWeek = (r) => r.date >= from && r.date <= to;
    const scores = {};

    for (const p of PLAYERS) {
      const mine = (r) => r.player_id === p;
      // La perte est déclarée semaine par semaine : la ligne de la semaine se
      // suffit à elle-même, il n'y a plus de pesée de référence à retrouver.
      const weighIn = rows.weighIns.find((w) => w.player_id === p && w.week_start === from) || null;

      scores[p] = scoreWeek({
        weekNumber: n,
        sessions: rows.sessions.filter((r) => mine(r) && inWeek(r)),
        pushups: rows.pushups.filter((r) => mine(r) && inWeek(r)),
        weighIn,
      });
      cumulative[p] += scores[p].total;
    }

    weeks.push({ number: n, from, to, defi: defiForWeek(n), scores });
  }

  return { startDate, weeksTotal, players, rows, today, maxWeek, weeks, cumulative };
}

/** Le payload complet d'un écran, en un aller-retour. */
function buildState(db, requested) {
  const all = computeAll(db);
  const current = Math.min(Math.max(weekNumber(all.today, all.startDate), 1), all.maxWeek);
  const n = Number.isInteger(requested) && requested >= 1 && requested <= all.maxWeek
    ? requested
    : current;
  const week = all.weeks[n - 1];

  // Points de chaque séance, tels que le barème les a calculés — le front ne
  // refait jamais ce calcul.
  const sessionPoints = new Map();
  for (const p of PLAYERS) {
    for (const c of week.scores[p].detail.act.sessions) sessionPoints.set(c.id, c);
  }

  const inWeek = (r) => r.date >= week.from && r.date <= week.to;
  const journal = {
    sessions: all.rows.sessions.filter(inWeek).map((r) => ({
      ...r,
      points: sessionPoints.get(r.id)?.points ?? 0,
      valid: sessionPoints.get(r.id)?.valid ?? false,
      backfilled: r.created_at.slice(0, 10) > r.date,
    })),
    pushups: all.rows.pushups.filter(inWeek).map((r) => ({
      ...r,
      backfilled: r.created_at.slice(0, 10) > r.date,
    })),
    weighIns: Object.fromEntries(
      PLAYERS.map((p) => [
        p,
        all.rows.weighIns.find((w) => w.player_id === p && w.week_start === week.from) || null,
      ]),
    ),
  };

  return {
    today: all.today,
    config: {
      start_date: all.startDate,
      weeks_total: all.weeksTotal,
      locked: all.rows.sessions.length + all.rows.pushups.length + all.rows.weighIns.length > 0,
    },
    players: all.players,
    week: {
      number: week.number,
      from: week.from,
      to: week.to,
      current: current === week.number,
      isLast: week.number >= all.weeksTotal,
    },
    defi: { id: week.defi.id, label: week.defi.label },
    scores: week.scores,
    cumulative: all.cumulative,
    journal,
    maxWeek: all.maxWeek,
    // Le challenge est terminé quand la dernière semaine prévue est révolue.
    finished: all.today > weekRange(all.weeksTotal, all.startDate).to,
    caps: CAPS,
    defis: DEFIS.map((d) => ({ id: d.id, label: d.label })),
  };
}

/* ------------------------------------------------------------------ *
 * Authentification
 * ------------------------------------------------------------------ */

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // timingSafeEqual exige des longueurs égales : on hache pour les normaliser.
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(ba).digest(),
    crypto.createHash('sha256').update(bb).digest(),
  );
}

function rateLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++entry.count > max) {
      return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans un quart d’heure.' });
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (req.signedCookies?.[COOKIE] === 'ok') return next();
  res.status(401).json({ error: 'Code d’accès requis.' });
}

/**
 * Défense en profondeur : avec `SameSite=Lax` une API JSON à cookie est déjà
 * hors de portée du CSRF, mais refuser une origine étrangère ne coûte rien.
 */
function sameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return res.status(403).json({ error: 'Origine invalide.' });
    }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Origine refusée.' });
  }
  next();
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

export function createApi(db, { accessCode, secure }) {
  const api = express.Router();
  const now = () => new Date().toISOString();
  const state = (week) => buildState(db, week);

  api.post('/auth', rateLimiter(), (req, res) => {
    if (!safeEqual(req.body?.code ?? '', accessCode)) {
      return res.status(401).json({ error: 'Code incorrect.' });
    }
    res.cookie(COOKIE, 'ok', {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      // `Secure` se décide par requête, pas une fois pour toutes au démarrage :
      // un téléphone qui arrive en http:// jetterait silencieusement un cookie
      // Secure, et se ferait renvoyer à l'écran de code à chaque saisie. Avec
      // `trust proxy`, `req.secure` suit X-Forwarded-Proto du reverse proxy.
      secure: secure ?? req.secure,
      maxAge: COOKIE_MAX_AGE,
    });
    res.json(state());
  });

  api.post('/logout', (req, res) => {
    res.clearCookie(COOKIE);
    res.status(204).end();
  });

  api.use(requireAuth);

  api.get('/state', (req, res) => {
    const week = req.query.week ? Number(req.query.week) : undefined;
    res.json(state(week));
  });

  api.get('/summary', (req, res) => {
    const all = computeAll(db);
    res.json({
      weeks: all.weeks.map((w) => ({
        number: w.number,
        from: w.from,
        to: w.to,
        defi: w.defi.label,
        a: w.scores.a.total,
        b: w.scores.b.total,
      })),
      cumulative: all.cumulative,
      players: all.players,
      weeksTotal: all.weeksTotal,
    });
  });

  api.use(sameOrigin);

  /** Rejoue la ligne déjà créée si le même `client_id` revient (double clic). */
  function replay(table, clientId) {
    if (!clientId) return null;
    return db.prepare(`SELECT date FROM ${table} WHERE client_id = ?`).get(clientId) || null;
  }

  api.post('/sessions', (req, res, next) => {
    try {
      const { startDate } = readSettings(db);
      const b = req.body ?? {};
      const done = replay('session', b.client_id);
      if (done) return res.json(state(weekNumber(done.date, startDate)));

      const player = readPlayer(b.player);
      const date = readDate(b.date, startDate);
      if (!DISCIPLINES.includes(b.discipline)) throw bad('Discipline inconnue.');
      const duration = readInt(b.duration_s, { min: 1, max: 36000, label: 'La durée' });

      db.prepare(
        `INSERT INTO session (player_id, date, discipline, duration_s, author, client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(player, date, b.discipline, duration, readName(b.author, player), b.client_id || null, now());

      res.json({
        ...state(weekNumber(date, startDate)),
        // Une séance trop courte est enregistrée quand même : c'est un fait
        // réel. Mais l'UI doit le dire, pas l'avaler en silence.
        notice: duration <= 1200
          ? 'Séance enregistrée, mais 20 minutes ou moins : 0 point, et pas de journée active.'
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  api.post('/pushups', (req, res, next) => {
    try {
      const { startDate } = readSettings(db);
      const b = req.body ?? {};
      const done = replay('pushup', b.client_id);
      if (done) return res.json(state(weekNumber(done.date, startDate)));

      const player = readPlayer(b.player);
      const date = readDate(b.date, startDate);
      const count = readInt(b.count, { min: 1, max: 2000, label: 'Le nombre de pompes' });

      db.prepare(
        `INSERT INTO pushup (player_id, date, count, author, client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(player, date, count, readName(b.author, player), b.client_id || null, now());

      res.json(state(weekNumber(date, startDate)));
    } catch (err) {
      next(err);
    }
  });

  // Suppression douce : à deux joueurs sans compte, on ne verrouille rien, on
  // trace. Rien n'est jamais réellement perdu.
  for (const [table, route] of [['session', 'sessions'], ['pushup', 'pushups']]) {
    api.delete(`/${route}/:id`, (req, res, next) => {
      try {
        const { startDate } = readSettings(db);
        const row = db
          .prepare(`SELECT date FROM ${table} WHERE id = ? AND deleted_at IS NULL`)
          .get(Number(req.params.id));
        if (!row) throw new HttpError(404, 'Ligne introuvable.');
        db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(now(), Number(req.params.id));
        res.json(state(weekNumber(row.date, startDate)));
      } catch (err) {
        next(err);
      }
    });
  }

  api.put('/weighins', (req, res, next) => {
    try {
      const { startDate } = readSettings(db);
      const b = req.body ?? {};
      const player = readPlayer(b.player);
      const n = readInt(b.week, { min: 1, max: 520, label: 'La semaine' });
      const weekStart = weekStartOf(n, startDate);
      // Bornes de saisie : ±50 kg en une semaine est déjà absurde, mais reste
      // représentable. La contrainte SQL est plus large, cf. la migration.
      const loss = readInt(b.loss_grams, { min: -50000, max: 50000, label: 'La perte' });
      const measured = b.measured_on && isDate(b.measured_on) ? b.measured_on : weekStart;

      // La clé (joueur, semaine) rend structurellement impossible d'avoir deux
      // pesées pour la même semaine : c'est un upsert, jamais un doublon.
      db.prepare(
        `INSERT INTO weigh_in (player_id, week_start, loss_grams, measured_on, author, created_at, updated_at)
         VALUES (@p, @w, @g, @m, @a, @t, @t)
         ON CONFLICT(player_id, week_start)
         DO UPDATE SET loss_grams = @g, measured_on = @m, author = @a, updated_at = @t`,
      ).run({ p: player, w: weekStart, g: loss, m: measured, a: readName(b.author, player), t: now() });

      res.json(state(n));
    } catch (err) {
      next(err);
    }
  });

  api.delete('/weighins', (req, res, next) => {
    try {
      const { startDate } = readSettings(db);
      const player = readPlayer(req.body?.player);
      const n = readInt(req.body?.week, { min: 1, max: 520, label: 'La semaine' });
      db.prepare('DELETE FROM weigh_in WHERE player_id = ? AND week_start = ?')
        .run(player, weekStartOf(n, startDate));
      res.json(state(n));
    } catch (err) {
      next(err);
    }
  });

  api.put('/config', (req, res, next) => {
    try {
      const b = req.body ?? {};
      const settings = readSettings(db);
      const upd = db.prepare('UPDATE player SET name = ? WHERE id = ?');

      db.transaction(() => {
        for (const p of settings.players) {
          const key = `name_${p.id}`;
          if (b[key] !== undefined) upd.run(readName(b[key], p.name), p.id);
        }
        if (b.weeks_total !== undefined) {
          setConfig(db, 'weeks_total', readInt(b.weeks_total, { min: 1, max: 520, label: 'Le nombre de semaines' }));
        }
        if (b.start_date !== undefined) {
          if (!isDate(b.start_date)) throw bad('Date de départ invalide.');
          const monday = isMonday(b.start_date) ? b.start_date : mondayOf(b.start_date);
          const used = db.prepare('SELECT COUNT(*) AS n FROM session WHERE deleted_at IS NULL').get().n
            + db.prepare('SELECT COUNT(*) AS n FROM pushup WHERE deleted_at IS NULL').get().n
            + db.prepare('SELECT COUNT(*) AS n FROM weigh_in').get().n;
          // Déplacer la date de départ ne rebascule aucune ligne, mais décale
          // la numérotation des semaines — donc la phase du cycle de défis, ce
          // qui ferait rétroactivement basculer des défis déjà validés.
          if (used > 0 && monday !== settings.startDate && b.force !== true) {
            throw bad(
              'Le challenge a déjà commencé : changer la date de départ renumérote les semaines et décale les défis. Renvoyez avec force = true si c’est voulu.',
            );
          }
          setConfig(db, 'start_date', monday);
        }
      })();

      res.json(state());
    } catch (err) {
      next(err);
    }
  });

  api.get('/export', (req, res) => {
    const all = computeAll(db);
    res.setHeader('Content-Disposition', `attachment; filename="challenge-${all.today}.json"`);
    res.json({
      exported_at: now(),
      config: { start_date: all.startDate, weeks_total: all.weeksTotal },
      players: all.players,
      ...all.rows,
    });
  });

  api.use((err, req, res, _next) => {
    if (!(err instanceof HttpError)) console.error(err);
    res.status(err.status || 500).json({
      error: err.status ? err.message : 'Erreur interne.',
    });
  });

  return api;
}

export { buildState, computeAll, COOKIE };
