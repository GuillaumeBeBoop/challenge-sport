# Challenge sportif

Journal d'activités et calcul automatique des points pour un challenge à deux,
noté sur 100 points par semaine. Le barème complet est rappelé dans l'application
elle-même, section « Le barème ».

Pas de compte : un code d'accès partagé, et chacun saisit ses lignes. Chaque
ligne garde le nom de qui l'a saisie.

## Déployer

```sh
cp .env.example .env
$EDITOR .env            # choisir ACCESS_CODE
docker compose up -d --build
```

Le service écoute sur `127.0.0.1:3000`. Le TLS est l'affaire du reverse proxy du
VPS — il n'y a pas de HTTPS dans le process Node. Exemple pour Caddy :

```
challenge.exemple.fr {
    reverse_proxy 127.0.0.1:3000
}
```

Le cookie de session porte le drapeau `Secure` quand la requête arrive en
HTTPS, et pas quand elle arrive en HTTP simple (réseau local, test) : un
appareil qui ouvre le site en clair se connecte quand même, au lieu de voir son
cookie jeté sans explication et de revenir en boucle à l'écran de code.
`COOKIE_SECURE` dans `.env` force le drapeau dans un sens ou dans l'autre.

Le reverse proxy doit passer `X-Forwarded-Proto` (Caddy et Nginx le font par
défaut) — c'est ce qui distingue les deux cas.

Si le VPS est en arm64, construire l'image sur le VPS (ou via `docker buildx
--platform`) plutôt que localement en x64.

## En développement

```sh
npm install
ACCESS_CODE=secret npm run dev
npm test
```

## Où vivent les règles

Dans `src/scoring.js`, et nulle part ailleurs. Le front n'a aucune connaissance
du barème : il affiche les points et les justifications que l'API a calculés.
`test/scoring.test.js` est la spécification exécutable des règles — pour changer
une règle, on modifie d'abord son test.

Les points ne sont jamais stockés. Ils sont recalculés à chaque lecture depuis
les lignes brutes : corriger une ligne suffit, il n'y a jamais de total à
rafraîchir.

Le **vélo** rapporte moitié moins que la course et la marche : 1 point par
20 minutes au lieu de 10. Le facteur ne joue que sur les points — pour le seuil
des 20 minutes, les journées actives et les défis, une minute de vélo reste une
minute. `HALF_RATE`, dans `src/scoring.js`, tient la liste des disciplines à
demi-tarif.

Le nombre de **joueurs** est libre : deux au départ, on en ajoute et on en
archive depuis les réglages. Rien n'est jamais supprimé — archiver masque un
joueur à partir de la semaine en cours, garde ses lignes et ses points passés,
et se défait d'un clic. Un joueur arrivé en cours de route n'est affiché et
compté qu'à partir de sa semaine d'arrivée, pour que son total général ne se
lise pas comme un mauvais score.

Le **malus** est la seule règle qui ne se déduit pas du journal : c'est une
sanction saisie à la main, qui divise le total de la semaine par 2, 3 ou 4. Le
motif est obligatoire — sans lui, un malus est incompréhensible un mois plus
tard. Diviser plutôt que soustraire garantit qu'un total ne peut pas devenir
négatif, et fait mal proportionnellement à la semaine.

La pesée enregistre les **kilos perdus dans la semaine**, pas un poids : c'est
le seul chiffre que le barème note, et c'est celui qu'on saisit. Les semaines
sont donc indépendantes — corriger une perte corrige cette semaine et elle
seule. La semaine 1 sert de point de départ et ne rapporte aucun point.

## Sauvegarde et restauration

L'application écrit chaque jour une copie dans `/data/backups/` (les 14
dernières sont conservées) via `db.backup()` — jamais un `cp`, qui corromprait
une base en mode WAL.

```sh
# Copier une sauvegarde hors du conteneur
docker compose cp challenge:/data/backups ./backups

# Restaurer
docker compose down
docker compose run --rm -T challenge sh -c 'cp /data/backups/challenge-AAAA-MM-JJ.sqlite /data/challenge.sqlite && rm -f /data/challenge.sqlite-wal /data/challenge.sqlite-shm'
docker compose up -d
```

Le lien « Exporter le journal » en bas de page télécharge tout le journal en
JSON — plus pratique à relire qu'un instantané binaire.

## Réglages

Dans l'application, section « Réglages » : la liste des joueurs (ajout,
archivage, réactivation), le premier lundi du challenge et le nombre de
semaines prévues. Les noms se changent directement sur les cartes.

La date de départ se verrouille dès qu'une ligne existe : la déplacer
renumérote les semaines et décale la phase du cycle de défis, ce qui ferait
rétroactivement basculer des défis déjà validés. L'application demande une
confirmation explicite.
