/**
 * Arithmétique de dates civiles.
 *
 * Règle unique dont tout le reste découle : l'application ne dérive JAMAIS une
 * date d'un timestamp. Une date est une chaîne `YYYY-MM-DD` sans heure ni
 * fuseau, soumise explicitement par le client. Les seules conversions vers un
 * instant se font ici, ancrées à midi UTC — ainsi aucun changement d'heure ne
 * peut décaler un calcul d'un jour.
 */

const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');

/** Vraie date civile ? Rejette aussi le 2026-02-30, que la regex laisse passer. */
export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function assertDate(s, label = 'date') {
  if (!isDate(s)) throw new TypeError(`${label} invalide : ${JSON.stringify(s)}`);
}

/** Instant d'ancrage : midi UTC du jour donné. */
function anchor(s) {
  assertDate(s);
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 12);
}

function fromAnchor(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** La date d'aujourd'hui telle que la vivent les joueurs, quel que soit le TZ du serveur. */
export function todayParis(now = new Date()) {
  // 'sv-SE' produit nativement du YYYY-MM-DD.
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(now);
}

export function addDays(date, n) {
  return fromAnchor(anchor(date) + n * DAY_MS);
}

/** Nombre de jours de `from` vers `to` ; négatif si `to` précède `from`. */
export function diffDays(from, to) {
  return Math.round((anchor(to) - anchor(from)) / DAY_MS);
}

/** 1 = lundi … 7 = dimanche (ISO). */
export function dayOfWeek(date) {
  return ((new Date(anchor(date)).getUTCDay() + 6) % 7) + 1;
}

/** Le lundi de la semaine calendaire contenant `date`. Indépendant de start_date. */
export function mondayOf(date) {
  return addDays(date, -(dayOfWeek(date) - 1));
}

export function isMonday(date) {
  return dayOfWeek(date) === 1;
}

/**
 * Numéro de semaine du challenge : 1 pour la semaine de `startDate`, puis +1
 * par semaine. Vaut 0 ou moins pour une date antérieure au challenge.
 */
export function weekNumber(date, startDate) {
  return Math.floor(diffDays(startDate, date) / 7) + 1;
}

/** Le lundi qui ouvre la semaine numéro `n`. */
export function weekStartOf(n, startDate) {
  return addDays(startDate, (n - 1) * 7);
}

/** Bornes inclusives de la semaine `n`. */
export function weekRange(n, startDate) {
  const from = weekStartOf(n, startDate);
  return { from, to: addDays(from, 6) };
}

/** `2026-09-14` → `14 sept.` */
export function formatShort(date) {
  return new Date(anchor(date)).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}
