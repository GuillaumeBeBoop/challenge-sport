/**
 * Les quatre défis hebdomadaires. Tout ou rien, 5 points, validés
 * automatiquement à partir du journal de la semaine.
 *
 * Le cycle recommence en semaine 5 : S5 reprend le défi de S1, etc.
 *
 * Chaque prédicat reçoit le contexte construit par `scoring.js` :
 *   ctx.sessions   toutes les séances de la semaine (valides ou non)
 *   ctx.days       Map date → { validSeconds, pushups }
 *   ctx.activeDays dates actives de la semaine, triées
 *
 * `ctx` ne contient QUE les lignes de la semaine notée. C'est ce qui garantit
 * qu'une série de jours actifs à cheval sur deux semaines (samedi, dimanche,
 * lundi) ne valide le défi S3 dans aucune des deux : chaque semaine reste
 * notable indépendamment.
 */

/** Une séance ne compte qu'au-delà de 20:00 strict. Doit rester aligné sur scoring.js. */
const VALID_SESSION_S = 1200;

function longestRun(dates) {
  if (dates.length === 0) return 0;
  const DAY = 86400000;
  const ms = dates.map((d) => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y, m - 1, day, 12);
  });
  let best = 1;
  let run = 1;
  for (let i = 1; i < ms.length; i++) {
    run = Math.round((ms[i] - ms[i - 1]) / DAY) === 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

export const DEFIS = [
  {
    id: 'seance-60',
    label: "60 min d'activité en une seule séance",
    // Attention : une SEULE séance de 60 min ou plus. À ne pas confondre avec
    // le défi S4, qui accepte un cumul sur la journée.
    test(ctx) {
      const best = ctx.sessions.reduce((m, s) => Math.max(m, s.duration_s), 0);
      return { done: best >= 3600, progress: { bestSessionS: best, targetS: 3600 } };
    },
  },
  {
    id: 'pompes-100',
    label: '100 pompes dans la même journée',
    test(ctx) {
      let best = 0;
      for (const d of ctx.days.values()) best = Math.max(best, d.pushups);
      return { done: best >= 100, progress: { bestDay: best, target: 100 } };
    },
  },
  {
    id: 'trois-jours',
    label: '3 journées actives consécutives',
    test(ctx) {
      const run = longestRun(ctx.activeDays);
      return { done: run >= 3, progress: { longestRun: run, target: 3 } };
    },
  },
  {
    id: 'combo',
    label: '60 min d’activité + 50 pompes le même jour',
    // Ici le cumul des séances VALIDES de la journée suffit, contrairement à S1.
    test(ctx) {
      let bestS = 0;
      let bestP = 0;
      let done = false;
      for (const d of ctx.days.values()) {
        if (d.validSeconds >= 3600 && d.pushups >= 50) done = true;
        bestS = Math.max(bestS, d.validSeconds);
        bestP = Math.max(bestP, d.pushups);
      }
      return { done, progress: { bestSecondsInADay: bestS, bestPushupsInADay: bestP } };
    },
  },
];

export function defiForWeek(weekNumber) {
  const i = ((((weekNumber - 1) % DEFIS.length) + DEFIS.length) % DEFIS.length);
  return DEFIS[i];
}

export { VALID_SESSION_S };
