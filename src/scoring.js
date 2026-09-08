/**
 * LE BARÈME. Seule implémentation des règles de tout le projet — le front ne
 * recalcule jamais rien, il affiche ce que ce module a produit.
 *
 * Module PUR : il ne touche jamais la base. On lui passe les lignes d'une
 * semaine, il rend un détail complet. C'est ce qui le rend testable sans
 * fixture, et c'est la table de tests qui fait office de spécification.
 *
 * Les points ne sont jamais persistés : tout est recalculé à la lecture. Une
 * pesée corrigée en semaine 3 répare donc automatiquement les semaines 4 à 12.
 *
 * INVARIANT CENTRAL — les plafonds s'appliquent aux POINTS, jamais aux FAITS.
 * Une séance qui ne rapporte rien parce qu'on est déjà à 45 points rend quand
 * même sa journée active et compte quand même pour le défi. Idem pour les
 * pompes au-delà de 250.
 */

import { defiForWeek } from './defis.js';

/** Une séance ne compte qu'au-delà de 20:00 STRICT. 20:00 pile vaut 0. */
export const VALID_SESSION_S = 1200;
/** 1 point par tranche pleine de 10 minutes, arrondi PAR SÉANCE. */
export const POINT_BLOCK_S = 600;
/** Une journée est active dès 30 pompes, même sans séance valide. */
export const ACTIVE_PUSHUPS = 30;
/** Un défi de 60 min se déclenche à 60:00 pile (>=), contrairement au > 20:00. */
export const DEFI_LONG_S = 3600;

export const CAPS = { act: 45, pomp: 25, reg: 15, poids: 10, defi: 5 };

/** Paliers de régularité, indexés par le nombre de journées actives. */
export const REG_TIERS = [0, 0, 3, 6, 9, 12, 15, 15];

/** Paliers de perte de poids, en grammes, du plus exigeant au plus faible. */
export const WEIGHT_TIERS = [
  { grams: 1000, points: 10 },
  { grams: 750, points: 6 },
  { grams: 500, points: 4 },
  { grams: 250, points: 2 },
];

/**
 * Ce qui est enregistré est la PERTE de la semaine, déclarée par le joueur, et
 * non son poids : c'est le chiffre que le barème note, et le seul qu'on saisit.
 *
 * Deux conséquences assumées. Les semaines sont indépendantes : corriger une
 * perte corrige cette semaine et elle seule, là où une chaîne de poids absolus
 * réparait aussi les suivantes. Et rien ne relie les pertes déclarées à une
 * balance : prendre 1 kg sans le déclarer (0 pt, jamais de malus) puis le
 * reperdre rapporte 10 points pour zéro progrès net. À deux joueurs qui se font
 * confiance, c'est le prix d'une saisie qui tient en un nombre.
 */

/**
 * Diviseurs de malus autorisés. Un malus n'est pas déduit du journal : c'est
 * une sanction saisie à la main, avec son motif et le nom de qui l'a posée.
 * Diviser plutôt que soustraire garantit qu'un total ne peut pas devenir
 * négatif, et fait mal proportionnellement à la semaine — ce qui évite le cas
 * absurde d'un malus fixe qui punit plus une bonne semaine qu'une mauvaise.
 */
export const MALUS_DIVISORS = [2, 3, 4];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Agrège la semaine par jour. Base commune aux jours actifs et aux défis. */
function buildDays(sessions, pushups) {
  const days = new Map();
  const slot = (date) => {
    if (!days.has(date)) days.set(date, { date, validSeconds: 0, pushups: 0 });
    return days.get(date);
  };
  for (const s of sessions) {
    const d = slot(s.date);
    if (s.duration_s > VALID_SESSION_S) d.validSeconds += s.duration_s;
  }
  for (const p of pushups) slot(p.date).pushups += p.count;
  return days;
}

function weightTier(lossGrams) {
  for (const t of WEIGHT_TIERS) if (lossGrams >= t.grams) return t;
  return null;
}

/**
 * Note une semaine.
 *
 * @param {object}   input
 * @param {number}   input.weekNumber        1 pour la première semaine du challenge.
 * @param {Array}    input.sessions          Séances de CETTE semaine : { id, date, discipline, duration_s }.
 * @param {Array}    input.pushups           Pompes de CETTE semaine : { id, date, count }.
 * @param {?object}  input.weighIn           Pesée de la semaine : { loss_grams } ou null.
 * @param {?object}  input.penalty           Malus de la semaine : { divisor, reason } ou null.
 */
export function scoreWeek({
  weekNumber,
  sessions = [],
  pushups = [],
  weighIn = null,
  penalty = null,
}) {
  const days = buildDays(sessions, pushups);

  // --- 1. Activités : arrondi par séance, jamais sur le total.
  const contributions = sessions.map((s) => {
    const valid = s.duration_s > VALID_SESSION_S;
    return {
      id: s.id,
      date: s.date,
      discipline: s.discipline,
      duration_s: s.duration_s,
      valid,
      points: valid ? Math.floor(s.duration_s / POINT_BLOCK_S) : 0,
    };
  });
  const actRaw = sum(contributions.map((c) => c.points));
  const act = Math.min(actRaw, CAPS.act);

  // --- 2. Pompes : on cumule toute la semaine, on tronque une seule fois.
  const pushTotal = sum(pushups.map((p) => p.count));
  const pompRaw = Math.floor(pushTotal / 10);
  const pomp = Math.min(pompRaw, CAPS.pomp);

  // --- 3. Régularité : paliers non cumulatifs.
  const activeDays = [...days.values()]
    .filter((d) => d.validSeconds > 0 || d.pushups >= ACTIVE_PUSHUPS)
    .map((d) => d.date)
    .sort();
  const reg = REG_TIERS[Math.min(activeDays.length, REG_TIERS.length - 1)];

  // --- 4. Poids : paliers sur la perte déclarée, jamais de points négatifs.
  // La semaine 1 n'a pas de semaine antérieure DANS le challenge : sa perte est
  // enregistrée comme point de départ, elle ne rapporte rien.
  const isReference = weekNumber <= 1;
  const lossGrams = weighIn ? weighIn.loss_grams : null;
  let poids = 0;
  if (lossGrams !== null && !isReference) {
    const tier = weightTier(lossGrams);
    poids = tier ? tier.points : 0;
  }

  // --- 5. Défi : tout ou rien.
  const defiDef = defiForWeek(weekNumber);
  const outcome = defiDef.test({ sessions, days, activeDays });
  const defi = outcome.done ? CAPS.defi : 0;

  // --- 6. Malus : le total de la semaine divisé. Un diviseur inconnu est
  // ignoré plutôt que refusé — le barème ne doit jamais échouer sur une ligne
  // douteuse, la validation des saisies est le travail de l'API.
  const rawTotal = act + pomp + reg + poids + defi;
  const divisor = MALUS_DIVISORS.includes(penalty?.divisor) ? penalty.divisor : 1;
  const total = Math.floor(rawTotal / divisor);

  return {
    weekNumber,
    act,
    pomp,
    reg,
    poids,
    defi,
    // Les sources gardent leurs points : ce sont des faits. Seul le total est
    // divisé, et `rawTotal` garde de quoi montrer l'opération à l'écran.
    rawTotal,
    total,
    detail: {
      act: {
        points: act,
        raw: actRaw,
        cap: CAPS.act,
        capped: actRaw > CAPS.act,
        validSeconds: sum(contributions.filter((c) => c.valid).map((c) => c.duration_s)),
        sessions: contributions,
      },
      pomp: {
        points: pomp,
        raw: pompRaw,
        cap: CAPS.pomp,
        capped: pompRaw > CAPS.pomp,
        total: pushTotal,
      },
      reg: {
        points: reg,
        cap: CAPS.reg,
        count: activeDays.length,
        days: activeDays,
        nextTierAt: activeDays.length < 6 ? activeDays.length + 1 : null,
      },
      poids: {
        points: poids,
        cap: CAPS.poids,
        // Semaine 1 : la perte sert de point de départ et ne rapporte rien.
        // L'UI doit afficher « référence », pas « 0 / 10 ».
        isReference,
        lossGrams,
      },
      defi: {
        points: defi,
        cap: CAPS.defi,
        id: defiDef.id,
        label: defiDef.label,
        done: outcome.done,
        progress: outcome.progress,
      },
      malus: {
        divisor,
        reason: penalty?.reason || null,
        author: penalty?.author || null,
        // Ce que la sanction a coûté, pour l'afficher sans le recalculer.
        removed: rawTotal - total,
      },
    },
  };
}
