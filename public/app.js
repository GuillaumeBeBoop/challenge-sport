/**
 * Rendu pur. Ce fichier ne connaît AUCUNE règle du barème : il affiche les
 * points et les justifications calculés par le serveur. Toute logique de calcul
 * ajoutée ici serait une seconde implémentation vouée à diverger.
 */

const $ = (id) => document.getElementById(id);
const PLAYERS = ['a', 'b'];
const DISCIPLINES = { course: 'Course', marche: 'Marche', velo: 'Vélo' };
const SOURCES = [
  ['act', 'Activités', 'var(--s1)'],
  ['pomp', 'Pompes', 'var(--s2)'],
  ['reg', 'Régularité', 'var(--s3)'],
  ['poids', 'Poids', 'var(--s4)'],
  ['defi', 'Défi', 'var(--s5)'],
];

let state = null;
let wantWeek = null;
let me = localStorage.getItem('challenge.me') === 'b' ? 'b' : 'a';

/* ---------------------------------------------------------------- *
 * Réseau
 * ---------------------------------------------------------------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showGate();
    throw new Error('auth');
  }
  const data = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(data.error || 'Erreur inattendue.');
  return data;
}

const COOKIE_REFUSED =
  'Code accepté, mais ce navigateur n’a pas gardé le cookie de session. '
  + 'Si l’adresse commence par http://, rouvrez le site en https://. Sinon, '
  + 'vérifiez que les cookies ne sont pas bloqués, et ouvrez le lien dans '
  + 'Safari ou Chrome plutôt que dans le navigateur intégré d’une messagerie.';

function showGate() {
  $('gate').hidden = false;
  $('app').hidden = true;
}

function fail(err) {
  if (err.message === 'auth') return;
  const box = $('error');
  box.textContent = err.message;
  box.hidden = false;
  clearTimeout(fail.t);
  fail.t = setTimeout(() => { box.hidden = true; }, 6000);
}

function note(msg) {
  $('foot').textContent = msg;
  clearTimeout(note.t);
  note.t = setTimeout(() => {
    $('foot').textContent = 'Les points se recalculent tout seuls à partir du journal.';
  }, 5000);
}

/* ---------------------------------------------------------------- *
 * Formats
 * ---------------------------------------------------------------- */

const pad = (n) => String(n).padStart(2, '0');

/** Accepte « 32 », « 32:45 » ou « 1:05:00 ». Rend des secondes, ou null. */
function parseDuration(raw) {
  const s = String(raw ?? '').trim().replace(',', ':');
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.length === 1) return n[0] * 60;
  if (n.length === 2) return n[0] * 60 + n[1];
  return n[0] * 3600 + n[1] * 60 + n[2];
}

/**
 * Accepte « 0,4 », « 0.4 », « 2 ». Rend un nombre, ou null si illisible —
 * jamais 0 par défaut : « 0 » (aucune perte) est une valeur légitime, la
 * confondre avec une saisie ratée enregistrerait une semaine à tort.
 *
 * Le signe est toléré par le parsing et refusé par la saisie : mieux vaut un
 * message qui dit quoi faire qu'un « illisible » sur un « -0,3 » bien formé.
 */
function parseKg(raw) {
  const s = String(raw ?? '').trim().replace(',', '.');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h} h ${pad(m)}`;
  return s ? `${m} min ${pad(s)}` : `${m} min`;
}

const fmtKgAbs = (g) => `${(Math.abs(g) / 1000).toFixed(2).replace('.', ',')} kg`;
/** Signe explicite, sauf pour zéro : « ±0,00 kg » se lirait comme une erreur. */
const fmtLoss = (g) => (g === 0 ? '0,00 kg' : `${g > 0 ? '−' : '+'}${fmtKgAbs(g)}`);

function fmtDayLong(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

function fmtDayShort(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

/** Identifiant d'idempotence. `crypto.randomUUID` n'existe qu'en contexte
 *  sécurisé : en HTTP simple sur le réseau local, il faut un repli. */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const nameOf = (p) => state?.players.find((x) => x.id === p)?.name || p;

/* ---------------------------------------------------------------- *
 * Cartes des joueurs — construites une fois, mises à jour ensuite,
 * pour ne pas voler le focus pendant qu'on renomme un joueur.
 * ---------------------------------------------------------------- */

function makeCard(p) {
  const card = el('div', `pcard p${p}`);
  const head = el('div', 'phead');
  const name = document.createElement('input');
  name.className = 'pname';
  name.setAttribute('aria-label', 'Nom du joueur');
  name.maxLength = 40;
  name.addEventListener('change', async () => {
    try {
      await refresh(await api('/config', { method: 'PUT', body: { [`name_${p}`]: name.value } }));
    } catch (err) { fail(err); }
  });
  const crown = el('span', 'crown', 'en tête');
  head.append(name, crown);

  const big = el('div', 'big');
  const total = el('b');
  big.append(total, el('span', null, 'pts sur 100'));

  const mini = el('div', 'mini');
  const rows = el('div', 'rows');
  const cells = {};
  for (const [key, label, color] of SOURCES) {
    const row = el('div');
    const sw = el('span', 'sw');
    sw.style.background = color;
    const det = el('span', 'det');
    const vl = el('span', 'vl');
    row.append(sw, el('span', 'nm', label), det, vl, el('span', 'mx', `/ ${' '}`));
    rows.append(row);
    cells[key] = { det, vl, mx: row.lastChild };
  }

  // Le malus n'est pas une source : il ne peut pas être un segment de barre ni
  // une ligne « x / cap ». Il a sa propre ligne, qui montre l'opération.
  const malus = el('div', 'malus');

  const season = el('div', 'season');
  const seasonVal = el('b');
  season.append(el('span', null, 'Total général'), seasonVal);

  card.append(head, big, mini, rows, malus, season);

  return {
    el: card,
    update(st) {
      const s = st.scores[p];
      const other = st.scores[p === 'a' ? 'b' : 'a'];
      const lead = s.total > other.total;
      card.classList.toggle('lead', lead);
      crown.hidden = !lead;
      if (document.activeElement !== name) name.value = nameOf(p);
      total.textContent = s.total;
      seasonVal.textContent = st.cumulative[p];

      const m = s.detail.malus;
      malus.hidden = m.divisor === 1;
      if (m.divisor > 1) {
        malus.replaceChildren(
          el('b', null, `Malus ÷ ${m.divisor}`),
          el('span', null, ` · ${s.rawTotal} pts ramenés à ${s.total} (−${m.removed})`),
          el('div', null, `« ${m.reason} » — ${m.author}`),
        );
      }

      mini.replaceChildren();
      for (const [key, , color] of SOURCES) {
        if (s[key] <= 0) continue;
        const i = el('i');
        i.style.width = `${s[key]}%`;
        i.style.background = color;
        mini.append(i);
      }

      const d = s.detail;
      const detail = {
        act: d.act.validSeconds ? fmtDuration(d.act.validSeconds) : '—',
        pomp: d.pomp.total ? `${d.pomp.total} pompes` : '—',
        reg: `${d.reg.count} ${d.reg.count > 1 ? 'jours' : 'jour'}`,
        poids: d.poids.lossGrams === null ? '—' : fmtLoss(d.poids.lossGrams),
        defi: d.defi.done ? 'validé' : 'en cours',
      };
      for (const [key] of SOURCES) {
        cells[key].det.textContent = detail[key];
        // Semaine 1 : afficher « référence » et non « 0 / 10 » — un zéro
        // ressemblerait à un échec alors que rien n'a été raté.
        const isRef = key === 'poids' && d.poids.isReference;
        cells[key].vl.textContent = isRef ? 'référence' : s[key];
        cells[key].vl.classList.toggle('ref', isRef);
        cells[key].mx.textContent = isRef ? '' : `/ ${st.caps[key]}`;
      }
    },
  };
}

const cards = { a: makeCard('a'), b: makeCard('b') };

/* ---------------------------------------------------------------- *
 * Rendu
 * ---------------------------------------------------------------- */

function renderHead(st) {
  const lab = $('wkLabel');
  lab.firstChild.nodeValue = `Semaine ${st.week.number}`;
  lab.querySelector('small').textContent = `${fmtDayShort(st.week.from)} – ${fmtDayShort(st.week.to)}`;
  $('prev').disabled = st.week.number <= 1;
  $('next').disabled = st.week.number >= st.maxWeek;

  const validated = PLAYERS.filter((p) => st.scores[p].detail.defi.done).map(nameOf);
  const banner = $('defiBanner');
  banner.classList.toggle('done', validated.length > 0);
  banner.replaceChildren(
    el('b', null, 'Défi de la semaine'),
    document.createTextNode(
      ` — ${st.defi.label}${validated.length ? ` · validé par ${validated.join(' et ')}` : ' · pas encore validé'}`,
    ),
  );

  $('final').hidden = !st.finished;
  if (st.finished) {
    const [a, b] = [st.cumulative.a, st.cumulative.b];
    $('finalText').textContent = a === b
      ? `Challenge terminé après ${st.config.weeks_total} semaines : égalité, ${a} points partout.`
      : `Challenge terminé après ${st.config.weeks_total} semaines : ${nameOf(a > b ? 'a' : 'b')} l’emporte, ${Math.max(a, b)} contre ${Math.min(a, b)}.`;
  }
}

function renderWho() {
  const seg = $('whoSeg');
  if (seg.children.length !== 2) {
    seg.replaceChildren(...PLAYERS.map((p) => {
      const b = el('button');
      b.type = 'button';
      b.addEventListener('click', () => {
        me = p;
        localStorage.setItem('challenge.me', p);
        render();
      });
      return b;
    }));
  }
  PLAYERS.forEach((p, i) => {
    seg.children[i].textContent = nameOf(p);
    seg.children[i].setAttribute('aria-pressed', me === p ? 'true' : 'false');
  });
}

function renderJournal(st) {
  const host = $('journal');
  const items = [];

  for (const s of st.journal.sessions) {
    items.push({
      date: s.date, player: s.player_id, author: s.author,
      backfilled: s.backfilled, created: s.created_at.slice(0, 10),
      what: `${DISCIPLINES[s.discipline] ?? s.discipline} · ${fmtDuration(s.duration_s)}`,
      points: `${s.points} pt${s.points > 1 ? 's' : ''}`,
      zero: s.points === 0,
      title: s.valid ? null : 'Séance de 20 min ou moins : elle ne rapporte rien et ne rend pas la journée active.',
      del: () => api(`/sessions/${s.id}`, { method: 'DELETE' }),
    });
  }
  for (const p of st.journal.pushups) {
    items.push({
      date: p.date, player: p.player_id, author: p.author,
      backfilled: p.backfilled, created: p.created_at.slice(0, 10),
      what: `${p.count} pompes`, points: '—', zero: true,
      del: () => api(`/pushups/${p.id}`, { method: 'DELETE' }),
    });
  }
  for (const p of PLAYERS) {
    const x = st.journal.penalties[p];
    if (!x) continue;
    items.push({
      date: x.week_start, player: p, author: x.author,
      what: `Malus ÷ ${x.divisor} · ${x.reason}`, points: `−${st.scores[p].detail.malus.removed}`,
      del: () => {
        if (!confirm('Retirer ce malus ?')) return null;
        return api('/penalties', { method: 'DELETE', body: { player: p, week: st.week.number } });
      },
    });
  }

  for (const p of PLAYERS) {
    const w = st.journal.weighIns[p];
    if (!w) continue;
    items.push({
      date: w.measured_on, player: p, author: w.author,
      what: `Pesée · ${fmtLoss(w.loss_grams)}`, points: '—', zero: true,
      del: () => {
        if (!confirm('Supprimer cette pesée ? Les points poids de la semaine seront perdus.')) return null;
        return api('/weighins', { method: 'DELETE', body: { player: p, week: st.week.number } });
      },
    });
  }

  if (!items.length) {
    host.replaceChildren(el('p', 'empty', 'Rien d’enregistré pour cette semaine.'));
    $('jCount').textContent = '';
    return;
  }
  items.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  $('jCount').textContent = `${items.length} ligne${items.length > 1 ? 's' : ''}`;

  const frag = document.createDocumentFragment();
  let day = null;
  for (const it of items) {
    if (it.date !== day) {
      day = it.date;
      frag.append(el('div', 'dayhead', fmtDayLong(day)));
    }
    const row = el('div', 'ent');
    row.append(el('span', `tag ${it.player}`, nameOf(it.player).slice(0, 12)));

    const what = el('span', 'what');
    what.append(document.createTextNode(it.what));
    if (it.backfilled) {
      what.append(el('small', null, `saisi le ${fmtDayShort(it.created)} par ${it.author}`));
    }
    row.append(what);

    const pt = el('span', `pt${it.zero ? ' zero' : ''}`, it.points);
    if (it.title) pt.title = it.title;
    row.append(pt);

    const rm = el('button', 'rm', '×');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Supprimer cette ligne');
    rm.addEventListener('click', async () => {
      try {
        const next = await it.del();
        if (next) refresh(next);
      } catch (err) { fail(err); }
    });
    row.append(rm);
    frag.append(row);
  }
  host.replaceChildren(frag);
}

function renderSettings(st) {
  $('startDate').value = st.config.start_date;
  $('weeksTotal').value = st.config.weeks_total;
  $('setHint').textContent = st.config.locked
    ? 'Le challenge a commencé : changer la date de départ renumérote les semaines et décale les défis. Une confirmation sera demandée.'
    : 'Aucune ligne enregistrée pour l’instant : la date de départ se change librement.';

  const list = $('defiList');
  if (list.children.length !== st.defis.length) {
    list.replaceChildren(...st.defis.map((d, i) => {
      const tr = el('tr');
      tr.append(el('td', 'n'), el('td', null, d.label));
      tr.firstChild.append(el('b', null, `S${i + 1}`));
      return tr;
    }));
  }

  // On ne saisit jamais un poids, seulement la perte de la semaine : c'est le
  // chiffre que le barème note, et c'est ce que la base stocke.
  const w = st.journal.weighIns[me];
  const kg = $('wKg');
  const hint = $('wHint');
  if (document.activeElement !== kg) {
    kg.value = w ? (w.loss_grams / 1000).toFixed(2).replace('.', ',') : '';
  }
  hint.className = 'hint';
  hint.textContent = st.week.number === 1
    ? 'Kilos perdus depuis la semaine dernière : « 0,4 » pour 400 g, « 0 » si'
      + ' vous n’avez pas perdu. Semaine 1 : la saisie sert de point de départ'
      + ' et ne rapporte aucun point.'
    : `Kilos perdus depuis la semaine dernière : « 0,4 » pour 400 g perdus,`
      + ` « 0 » si vous n’avez pas perdu. À jeun, même balance. Une seule pesée`
      + ` par semaine — ${w ? 'celle-ci sera remplacée' : 'aucune saisie pour l’instant'}.`;

  // Malus de la semaine affichée, pour le joueur sélectionné.
  const pen = st.journal.penalties[me];
  const div = $('mDiv');
  const why = $('mWhy');
  if (document.activeElement !== div) div.value = String(pen ? pen.divisor : 2);
  if (document.activeElement !== why) why.value = pen ? pen.reason : '';
  $('delM').disabled = !pen;
  $('mHint').className = 'hint';
  $('mHint').textContent = pen
    ? `Malus en place : ÷ ${pen.divisor}, soit ${st.scores[me].detail.malus.removed} points perdus`
      + ' cette semaine. Appliquer à nouveau le remplace.'
    : 'Sanction saisie à la main : le total de la semaine est divisé. Le motif est'
      + ' obligatoire, et le nom de qui l’a posée est enregistré.';
}

function render() {
  if (!state) return;
  const st = state;
  const board = $('board');
  if (board.children.length !== 2) board.replaceChildren(cards.a.el, cards.b.el);
  renderHead(st);
  renderWho();
  cards.a.update(st);
  cards.b.update(st);
  renderJournal(st);
  renderSettings(st);
}

/**
 * Les champs date suivent le jour courant du serveur (Europe/Paris), tant que
 * personne ne les a changés à la main. `dataset.auto` retient la valeur qu'on a
 * posée : si le champ contient autre chose, c'est un choix du joueur et on n'y
 * touche pas. Sans ça, un onglet laissé ouvert sur un téléphone traverse la
 * minuit avec la date de la veille, et la séance part dans la mauvaise semaine.
 */
function syncDates() {
  for (const id of ['sDate', 'pDate']) {
    const el = $(id);
    if (el.value && el.value !== el.dataset.auto) continue;
    el.value = state.today;
    el.dataset.auto = state.today;
  }
}

function refresh(next) {
  state = next;
  wantWeek = next.week.number;
  $('gate').hidden = true;
  $('app').hidden = false;
  syncDates();
  render();
  return next;
}

async function load(week = wantWeek) {
  refresh(await api(`/state${week ? `?week=${week}` : ''}`));
}

/* ---------------------------------------------------------------- *
 * Actions
 * ---------------------------------------------------------------- */

$('gateForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('gateError').hidden = true;
  try {
    const next = await api('/auth', { method: 'POST', body: { code: $('code').value } });
    // Le code peut être bon et le cookie refusé par le navigateur : `/auth`
    // renvoie l'état directement, donc l'appli s'ouvrirait quand même pour
    // rebondir ici à la première saisie, sans rien expliquer. Une lecture
    // authentifiée de plus, et on sait à qui la faute.
    await api('/state').catch((err) => {
      if (err.message === 'auth') throw new Error(COOKIE_REFUSED);
      throw err;
    });
    refresh(next);
    $('code').value = '';
  } catch (err) {
    $('gateError').textContent = err.message;
    $('gateError').hidden = false;
  }
});

$('logout').addEventListener('click', async (ev) => {
  ev.preventDefault();
  await api('/logout', { method: 'POST' }).catch(() => {});
  showGate();
});

$('prev').addEventListener('click', () => load(state.week.number - 1).catch(fail));
$('next').addEventListener('click', () => load(state.week.number + 1).catch(fail));

$('addS').addEventListener('click', async () => {
  const hint = $('sHint');
  const seconds = parseDuration($('sDur').value);
  if (!seconds) {
    hint.className = 'hint bad';
    hint.textContent = 'Durée illisible. Attendu : 32 ou 32:45.';
    return;
  }
  try {
    const next = await api('/sessions', {
      method: 'POST',
      body: {
        player: me, author: nameOf(me), date: $('sDate').value,
        discipline: $('sType').value, duration_s: seconds,
        client_id: uuid(),
      },
    });
    refresh(next);
    $('sDur').value = '';
    hint.className = `hint ${next.notice ? 'bad' : 'ok'}`;
    hint.textContent = next.notice || `Séance enregistrée en semaine ${next.week.number}.`;
  } catch (err) {
    hint.className = 'hint bad';
    hint.textContent = err.message;
  }
});

$('addP').addEventListener('click', async () => {
  const hint = $('pHint');
  const count = Number($('pCount').value);
  if (!Number.isInteger(count) || count < 1) {
    hint.className = 'hint bad';
    hint.textContent = 'Indiquez un nombre de pompes.';
    return;
  }
  try {
    const next = await api('/pushups', {
      method: 'POST',
      body: { player: me, author: nameOf(me), date: $('pDate').value, count, client_id: uuid() },
    });
    refresh(next);
    $('pCount').value = '';
    hint.className = 'hint ok';
    hint.textContent = `${count} pompes enregistrées en semaine ${next.week.number}.`;
  } catch (err) {
    hint.className = 'hint bad';
    hint.textContent = err.message;
  }
});

$('addW').addEventListener('click', async () => {
  const hint = $('wHint');
  const bad = (msg) => {
    hint.className = 'hint bad';
    hint.textContent = msg;
  };
  const value = parseKg($('wKg').value);
  if (value === null) {
    return bad('Nombre de kilos perdus illisible. Attendu : 0,4 — ou 0 si vous n’avez pas perdu.');
  }
  // Le barème ne note que les pertes : une prise vaut 0 point, jamais de malus.
  // Autant ne pas demander de la chiffrer.
  if (value < 0) return bad('On ne note que les pertes : mettez 0 si vous avez pris.');
  const loss = Math.round(value * 1000);
  if (loss > 50000) {
    return bad('Plus de 50 kg perdus en une semaine : vérifiez le nombre saisi.');
  }

  try {
    const next = await api('/weighins', {
      method: 'PUT',
      body: { player: me, author: nameOf(me), week: state.week.number, loss_grams: loss },
    });
    refresh(next);
    hint.className = 'hint ok';
    hint.textContent = `Semaine ${next.week.number} : ${fmtLoss(loss)} depuis la semaine dernière.`;
  } catch (err) {
    hint.className = 'hint bad';
    hint.textContent = err.message;
  }
});

$('addM').addEventListener('click', async () => {
  const hint = $('mHint');
  const reason = $('mWhy').value.trim();
  if (!reason) {
    hint.className = 'hint bad';
    hint.textContent = 'Indiquez le motif du malus : sans motif, il sera incompréhensible dans un mois.';
    return;
  }
  try {
    const next = await api('/penalties', {
      method: 'PUT',
      body: {
        player: me, author: nameOf(me), week: state.week.number,
        divisor: Number($('mDiv').value), reason,
      },
    });
    refresh(next);
    hint.className = 'hint ok';
    hint.textContent = `Malus appliqué : semaine ${next.week.number} ramenée à ${next.scores[me].total} points.`;
  } catch (err) {
    hint.className = 'hint bad';
    hint.textContent = err.message;
  }
});

$('delM').addEventListener('click', async () => {
  const hint = $('mHint');
  try {
    const next = await api('/penalties', {
      method: 'DELETE',
      body: { player: me, week: state.week.number },
    });
    refresh(next);
    hint.className = 'hint ok';
    hint.textContent = `Malus retiré : semaine ${next.week.number} à ${next.scores[me].total} points.`;
  } catch (err) {
    hint.className = 'hint bad';
    hint.textContent = err.message;
  }
});

$('saveStart').addEventListener('click', async () => {
  const start = $('startDate').value;
  if (!start) return;
  try {
    refresh(await api('/config', { method: 'PUT', body: { start_date: start } }));
    note('Date de départ enregistrée.');
  } catch (err) {
    if (!/force/.test(err.message)) return fail(err);
    if (!confirm(`${err.message.replace(/ Renvoyez.*/, '')}\n\nConfirmer ce changement ?`)) return;
    try {
      refresh(await api('/config', { method: 'PUT', body: { start_date: start, force: true } }));
      note('Date de départ modifiée, semaines renumérotées.');
    } catch (e) { fail(e); }
  }
});

$('saveWeeks').addEventListener('click', async () => {
  try {
    refresh(await api('/config', { method: 'PUT', body: { weeks_total: Number($('weeksTotal').value) } }));
    note('Durée du challenge mise à jour.');
  } catch (err) { fail(err); }
});

$('extend').addEventListener('click', async () => {
  try {
    refresh(await api('/config', { method: 'PUT', body: { weeks_total: state.config.weeks_total + 4 } }));
    note('Nouveau cycle de 4 semaines ouvert.');
  } catch (err) { fail(err); }
});

// Deux joueurs : ni polling ni SSE. Recharger quand l'onglet redevient visible
// suffit largement à voir arriver les lignes de l'autre.
const reload = () => { if (!document.hidden && state) load().catch(() => {}); };
window.addEventListener('focus', reload);
document.addEventListener('visibilitychange', reload);

/* ---------------------------------------------------------------- *
 * Démarrage
 * ---------------------------------------------------------------- */

try {
  // Les dates sont posées par `refresh()`, pas ici : au premier chargement
  // comme après la saisie du code, et à chaque retour sur l'onglet.
  await load();
} catch (err) {
  if (err.message !== 'auth') {
    showGate();
    $('gateError').textContent = err.message;
    $('gateError').hidden = false;
  }
}
