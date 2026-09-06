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
 * Référence de la pesée : la pesée antérieure la plus récente.
 *
 * Faille assumée : prendre 1 kg (0 pt, jamais de malus) puis le reperdre
 * rapporte 10 points pour zéro progrès net. Choix conservé pour rester fidèle
 * au barème d'origine. Pour fermer la faille, passer BASELINE à 'best' — la
 * référence devient alors le poids le plus bas jamais atteint, ce qui est
 * identique tant qu'on descend et neutralise l'effet yo-yo. Le calcul de la
 * référence se fait côté appelant (api.js), c'est là qu'il faut basculer.
 */
export const BASELINE = 'previous';

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
 * @param {?object}  input.weighIn           Pesée de la semaine : { grams } ou null.
 * @param {?object}  input.baselineWeighIn   Pesée de référence antérieure : { grams, week_start } ou null.
 */
export function scoreWeek({
  weekNumber,
  sessions = [],
  pushups = [],
  weighIn = null,
  baselineWeighIn = null,
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

  // --- 4. Poids : paliers, jamais de points négatifs.
  const isReference = weekNumber <= 1 || !baselineWeighIn;
  let lossGrams = null;
  let poids = 0;
  if (weighIn && baselineWeighIn) {
    lossGrams = baselineWeighIn.grams - weighIn.grams;
    const tier = weightTier(lossGrams);
    poids = tier ? tier.points : 0;
  }

  // --- 5. Défi : tout ou rien.
  const defiDef = defiForWeek(weekNumber);
  const outcome = defiDef.test({ sessions, days, activeDays });
  const defi = outcome.done ? CAPS.defi : 0;

  return {
    weekNumber,
    act,
    pomp,
    reg,
    poids,
    defi,
    total: act + pomp + reg + poids + defi,
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
        // Semaine 1, ou aucune pesée antérieure : la pesée sert de référence et
        // ne rapporte rien. L'UI doit afficher « référence », pas « 0 / 10 ».
        isReference,
        grams: weighIn ? weighIn.grams : null,
        baselineGrams: baselineWeighIn ? baselineWeighIn.grams : null,
        baselineWeekStart: baselineWeighIn ? baselineWeighIn.week_start : null,
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
    },
  };
}
