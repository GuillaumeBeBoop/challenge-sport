import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreWeek, CAPS } from '../src/scoring.js';
import { defiForWeek } from '../src/defis.js';

// Semaine 1 du challenge : lundi 7 → dimanche 13 septembre 2026.
const MON = '2026-09-07';
const d = (n) => `2026-09-${String(7 + n).padStart(2, '0')}`; // d(0) = lundi

let seq = 0;
const sess = (date, min, discipline = 'course') => ({
  id: ++seq,
  date,
  discipline,
  duration_s: Math.round(min * 60),
});
const secs = (date, s, discipline = 'course') => ({ id: ++seq, date, discipline, duration_s: s });
const push = (date, count) => ({ id: ++seq, date, count });

const score = (over = {}) => scoreWeek({ weekNumber: 1, sessions: [], pushups: [], ...over });

test('activités — l’exemple du barème : 30 course + 40 vélo + 50 marche = 12 pts', () => {
  const s = score({
    sessions: [sess(d(0), 30), sess(d(1), 40, 'velo'), sess(d(2), 50, 'marche')],
  });
  assert.equal(s.act, 12);
  assert.deepEqual(
    s.detail.act.sessions.map((c) => c.points),
    [3, 4, 5],
  );
});

test('activités — l’arrondi est par séance, jamais sur le total', () => {
  // 25 + 25 = 50 min. Par séance : 2 + 2 = 4. Sur le total ce serait 5.
  assert.equal(score({ sessions: [sess(d(0), 25), sess(d(1), 25)] }).act, 4);
});

test('activités — 20:00 pile ne compte pas, 20:01 compte', () => {
  assert.equal(score({ sessions: [secs(d(0), 1200)] }).act, 0);
  assert.equal(score({ sessions: [secs(d(0), 1201)] }).act, 2);
});

test('activités — une séance invalide ne rend pas la journée active', () => {
  const s = score({ sessions: [secs(d(0), 1200)] });
  assert.equal(s.detail.reg.count, 0);
  assert.equal(s.detail.act.sessions[0].valid, false);
});

test('activités — les secondes évitent de perdre une séance de 20:45', () => {
  // C'est tout l'intérêt de stocker des secondes : 20:45 arrondi à 20 min
  // deviendrait invalide et ferait sauter la journée active.
  const s = score({ sessions: [secs(d(0), 20 * 60 + 45)] });
  assert.equal(s.act, 2);
  assert.equal(s.detail.reg.count, 1);
});

test('activités — plafond à 45 points', () => {
  const sessions = [0, 1, 2, 3, 4, 5].map((i) => sess(d(i), 80)); // 8 pts × 6 = 48
  const s = score({ sessions });
  assert.equal(s.detail.act.raw, 48);
  assert.equal(s.act, CAPS.act);
  assert.equal(s.detail.act.capped, true);
});

test('INVARIANT — le plafond limite les points, pas les faits', () => {
  // 7 journées à 80 min : 56 points bruts, ramenés à 45. Les journées restent
  // actives malgré tout, et la régularité atteint son maximum.
  const sessions = [0, 1, 2, 3, 4, 5, 6].map((i) => sess(d(i), 80));
  const s = score({ sessions });
  assert.equal(s.act, CAPS.act);
  assert.equal(s.detail.reg.count, 7);
  assert.equal(s.reg, 15);
});

test('pompes — le cumul est tronqué une seule fois : 15 + 15 = 3 pts, pas 2', () => {
  assert.equal(score({ pushups: [push(d(0), 15), push(d(1), 15)] }).pomp, 3);
});

test('pompes — plafond à 25 points, et le surplus reste un fait', () => {
  const s = score({ pushups: [push(d(0), 300)] });
  assert.equal(s.detail.pomp.raw, 30);
  assert.equal(s.pomp, CAPS.pomp);
  assert.equal(s.detail.reg.count, 1, 'la journée reste active malgré le plafond');
});

test('régularité — 30 pompes suffisent à rendre une journée active, 29 non', () => {
  assert.equal(score({ pushups: [push(d(0), 30)] }).detail.reg.count, 1);
  assert.equal(score({ pushups: [push(d(0), 29)] }).detail.reg.count, 0);
});

test('régularité — 30 pompes atteintes en plusieurs séries dans la journée', () => {
  assert.equal(score({ pushups: [push(d(0), 20), push(d(0), 10)] }).detail.reg.count, 1);
});

test('régularité — les paliers, et le 7ᵉ jour qui n’ajoute rien', () => {
  const expected = [0, 0, 3, 6, 9, 12, 15, 15];
  for (let n = 0; n <= 7; n++) {
    const sessions = Array.from({ length: n }, (_, i) => sess(d(i), 30));
    assert.equal(score({ sessions }).reg, expected[n], `${n} jour(s)`);
  }
});

test('poids — les paliers en grammes, bornes exactes comprises', () => {
  const cases = [
    [0, 0], [249, 0], [250, 2], [499, 2], [500, 4],
    [749, 4], [750, 6], [999, 6], [1000, 10], [2500, 10],
  ];
  for (const [loss, points] of cases) {
    const s = scoreWeek({
      weekNumber: 2,
      weighIn: { grams: 80000 },
      baselineWeighIn: { grams: 80000 + loss, week_start: MON },
    });
    assert.equal(s.poids, points, `${loss} g`);
  }
});

test('poids — 82,40 kg contre 82,15 kg vaut bien 2 pts', () => {
  // Le cas exact qui casse en flottant : 82.40 - 82.15 === 0.2500000000000284.
  const s = scoreWeek({
    weekNumber: 2,
    weighIn: { grams: 82150 },
    baselineWeighIn: { grams: 82400, week_start: MON },
  });
  assert.equal(s.poids, 2);
});

test('poids — une reprise de poids vaut 0, jamais de points négatifs', () => {
  const s = scoreWeek({
    weekNumber: 2,
    weighIn: { grams: 81000 },
    baselineWeighIn: { grams: 80000, week_start: MON },
  });
  assert.equal(s.poids, 0);
  assert.equal(s.detail.poids.lossGrams, -1000);
});

test('poids — semaine 1 : la pesée est une référence, pas un échec', () => {
  const s = scoreWeek({ weekNumber: 1, weighIn: { grams: 80000 } });
  assert.equal(s.poids, 0);
  assert.equal(s.detail.poids.isReference, true);
});

test('poids — sans pesée cette semaine, 0 pt et pas de perte calculée', () => {
  const s = scoreWeek({
    weekNumber: 3,
    weighIn: null,
    baselineWeighIn: { grams: 80000, week_start: MON },
  });
  assert.equal(s.poids, 0);
  assert.equal(s.detail.poids.lossGrams, null);
});

test('poids — une semaine sautée ne casse pas la chaîne', () => {
  // Semaine 5 sans pesée ; la semaine 6 compare au dernier point connu
  // (semaine 4), que l'appelant fournit comme référence.
  const s = scoreWeek({
    weekNumber: 6,
    weighIn: { grams: 79000 },
    baselineWeighIn: { grams: 80000, week_start: '2026-09-28' },
  });
  assert.equal(s.poids, 10);
  assert.equal(s.detail.poids.baselineWeekStart, '2026-09-28');
});

test('défis — le cycle recommence en semaine 5', () => {
  assert.equal(defiForWeek(1).id, 'seance-60');
  assert.equal(defiForWeek(5).id, 'seance-60');
  assert.equal(defiForWeek(4).id, 'combo');
  assert.equal(defiForWeek(8).id, 'combo');
});

test('défi S1 — une SEULE séance de 60 min, un cumul ne suffit pas', () => {
  assert.equal(score({ sessions: [sess(d(0), 60)] }).defi, 5);
  assert.equal(score({ sessions: [sess(d(0), 59)] }).defi, 0);
  assert.equal(score({ sessions: [sess(d(0), 35), sess(d(0), 35)] }).defi, 0);
});

test('défi S2 — 100 pompes dans la MÊME journée', () => {
  const w2 = (pushups) => scoreWeek({ weekNumber: 2, sessions: [], pushups });
  assert.equal(w2([push(d(0), 60), push(d(0), 40)]).defi, 5);
  assert.equal(w2([push(d(0), 60), push(d(1), 40)]).defi, 0);
});

test('défi S3 — 3 jours actifs consécutifs', () => {
  const w3 = (sessions) => scoreWeek({ weekNumber: 3, sessions, pushups: [] });
  assert.equal(w3([sess(d(0), 30), sess(d(1), 30), sess(d(2), 30)]).defi, 5);
  assert.equal(w3([sess(d(0), 30), sess(d(1), 30), sess(d(3), 30)]).defi, 0);
});

test('défi S3 — la série ne peut pas franchir la frontière de semaine', () => {
  // Samedi et dimanche de la semaine 3, puis lundi : le lundi appartient à la
  // semaine suivante et n'est donc pas dans les lignes passées ici.
  const s = scoreWeek({
    weekNumber: 3,
    sessions: [sess(d(5), 30), sess(d(6), 30)],
    pushups: [],
  });
  assert.equal(s.defi, 0);
});

test('défi S4 — 60 min cumulées ET 50 pompes le même jour', () => {
  const w4 = (sessions, pushups) => scoreWeek({ weekNumber: 4, sessions, pushups });
  assert.equal(w4([sess(d(0), 35), sess(d(0), 25)], [push(d(0), 50)]).defi, 5);
  assert.equal(w4([sess(d(0), 60)], [push(d(1), 50)]).defi, 0, 'pas le même jour');
  assert.equal(w4([sess(d(0), 60)], [push(d(0), 49)]).defi, 0);
});

test('défi S4 — les séances invalides ne comptent pas dans les 60 min', () => {
  // 3 × 20:00 = 60 min au chronomètre, mais aucune séance valide.
  const s = scoreWeek({
    weekNumber: 4,
    sessions: [secs(d(0), 1200), secs(d(0), 1200), secs(d(0), 1200)],
    pushups: [push(d(0), 50)],
  });
  assert.equal(s.defi, 0);
});

test('les cinq sources se cumulent — le défi compte aussi dans act et pomp', () => {
  const s = scoreWeek({
    weekNumber: 1,
    sessions: [sess(d(0), 60)],
    pushups: [push(d(0), 30)],
  });
  assert.equal(s.act, 6, 'la séance du défi rapporte aussi ses points d’activité');
  assert.equal(s.pomp, 3);
  assert.equal(s.defi, 5);
});

test('une semaine parfaite vaut exactement 100', () => {
  const sessions = [0, 1, 2, 3, 4, 5].map((i) => sess(d(i), 80));
  const pushups = [0, 1, 2, 3, 4].map((i) => push(d(i), 50));
  const s = scoreWeek({
    weekNumber: 5, // défi S1 : une séance de 80 min le valide
    sessions,
    pushups,
    weighIn: { grams: 79000 },
    baselineWeighIn: { grams: 80000, week_start: '2026-09-28' },
  });
  assert.deepEqual(
    { act: s.act, pomp: s.pomp, reg: s.reg, poids: s.poids, defi: s.defi },
    { act: 45, pomp: 25, reg: 15, poids: 10, defi: 5 },
  );
  assert.equal(s.total, 100);
});

test('une semaine vide vaut 0 et ne casse rien', () => {
  const s = score();
  assert.equal(s.total, 0);
  assert.deepEqual(s.detail.reg.days, []);
});
