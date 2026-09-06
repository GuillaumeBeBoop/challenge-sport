import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays, diffDays, dayOfWeek, mondayOf, isMonday, isDate,
  weekNumber, weekStartOf, weekRange, todayParis,
} from '../src/dates.js';

// Changements d'heure 2026 en Europe/Paris : 29 mars et 25 octobre.
const SPRING = '2026-03-29';
const AUTUMN = '2026-10-25';

test('isDate rejette ce qui n’est pas une date civile réelle', () => {
  assert.equal(isDate('2026-09-07'), true);
  assert.equal(isDate('2026-02-30'), false, '30 février');
  assert.equal(isDate('2026-13-01'), false);
  assert.equal(isDate('2026-9-7'), false, 'sans zéros de tête');
  assert.equal(isDate('2026-09-07T10:00:00Z'), false, 'un timestamp n’est pas une date');
  assert.equal(isDate(20260907), false);
  assert.equal(isDate(null), false);
});

test('addDays traverse le passage à l’heure d’été sans décaler', () => {
  assert.equal(addDays('2026-03-28', 1), SPRING);
  assert.equal(addDays(SPRING, 1), '2026-03-30');
  assert.equal(addDays('2026-03-28', 7), '2026-04-04');
});

test('addDays traverse le passage à l’heure d’hiver sans décaler', () => {
  assert.equal(addDays('2026-10-24', 1), AUTUMN);
  assert.equal(addDays(AUTUMN, 1), '2026-10-26');
  assert.equal(addDays('2026-10-24', 7), '2026-10-31');
});

test('addDays traverse le passage d’année et les années bissextiles', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
});

test('diffDays reste exact à travers les changements d’heure', () => {
  assert.equal(diffDays('2026-03-28', '2026-03-30'), 2);
  assert.equal(diffDays('2026-10-24', '2026-10-26'), 2);
  assert.equal(diffDays('2026-01-01', '2027-01-01'), 365);
  assert.equal(diffDays('2026-09-14', '2026-09-07'), -7);
  assert.equal(diffDays('2026-09-07', '2026-09-07'), 0);
});

test('dayOfWeek suit l’ISO : lundi = 1, dimanche = 7', () => {
  assert.equal(dayOfWeek('2026-09-07'), 1);
  assert.equal(dayOfWeek('2026-09-13'), 7);
  assert.equal(dayOfWeek(SPRING), 7, 'le 29 mars 2026 est un dimanche');
});

test('mondayOf ramène au lundi, y compris depuis le lundi lui-même', () => {
  assert.equal(mondayOf('2026-09-07'), '2026-09-07');
  assert.equal(mondayOf('2026-09-13'), '2026-09-07', 'le dimanche appartient à sa semaine');
  assert.equal(mondayOf('2026-09-14'), '2026-09-14');
  assert.equal(mondayOf(SPRING), '2026-03-23');
  assert.equal(mondayOf(AUTUMN), '2026-10-19');
  assert.equal(isMonday('2026-09-07'), true);
  assert.equal(isMonday('2026-09-08'), false);
});

test('les numéros de semaine se dérivent de la date de départ', () => {
  const start = '2026-09-07';
  assert.equal(weekNumber('2026-09-07', start), 1);
  assert.equal(weekNumber('2026-09-13', start), 1, 'dimanche, encore la semaine 1');
  assert.equal(weekNumber('2026-09-14', start), 2);
  assert.equal(weekNumber('2026-09-28', start), 4);
  assert.equal(weekNumber('2026-09-06', start), 0, 'avant le challenge');
});

test('les numéros de semaine restent justes après un changement d’heure', () => {
  const start = '2026-03-23'; // la semaine du passage à l'heure d'été
  assert.equal(weekNumber(SPRING, start), 1);
  assert.equal(weekNumber('2026-03-30', start), 2);
  assert.equal(weekStartOf(2, start), '2026-03-30');
  assert.equal(weekNumber('2026-10-26', '2026-10-19'), 2);
});

test('weekRange donne des bornes de lundi à dimanche', () => {
  assert.deepEqual(weekRange(1, '2026-09-07'), { from: '2026-09-07', to: '2026-09-13' });
  assert.deepEqual(weekRange(3, '2026-09-07'), { from: '2026-09-21', to: '2026-09-27' });
});

test('todayParis ne suit pas l’UTC du serveur', () => {
  // 23 h 30 UTC le 1er janvier, il est déjà le 2 à Paris.
  assert.equal(todayParis(new Date('2026-01-01T23:30:00Z')), '2026-01-02');
  // 00 h 30 UTC le 29 mars, il est encore le 29 à Paris (01 h 30 CET).
  assert.equal(todayParis(new Date('2026-03-29T00:30:00Z')), '2026-03-29');
  // 22 h 30 UTC en été, il est déjà le lendemain à Paris (00 h 30 CEST).
  assert.equal(todayParis(new Date('2026-07-14T22:30:00Z')), '2026-07-15');
});
