# Matching règles + filtre libellé : « contient » confirmé, toggle regex — plan

## Contexte

Demande initiale : faire évoluer le filtre libellé de `/transactions` et
`findMatchingCategoryRule()` d'un match « exact » vers « contient » insensible
à la casse par défaut, avec un toggle regex (icône « r ») pour les cas
précis.

La prémisse est fausse, vérifiée contre le code et la base réelle : le
matching des règles est déjà « contient », insensible à la casse et aux
accents (`normalizeForMatch()` : NFD + strip diacritiques + toLowerCase +
trim, `src/lib/server/categorization/rules.ts:283-293`). Simulation sur la
base réelle (17 règles, 148 transactions, lecture seule) : le passage
exact→contient aurait élargi 2 règles (MAIF 1→3, LECLERC 0→4), mais ces
matchs existent déjà puisque le code fait déjà du contient — delta réel du
changement côté règles : zéro.

Ce qui reste donc réellement à faire :

1. Le seul écart réel : le filtre libellé de `/transactions`
   (`where.ts:24`, Prisma `contains` → SQLite LIKE) est insensible à la
   casse pour l'ASCII seulement et sensible aux accents — « Depenses » ne
   trouve pas « Dépenses », contrairement au moteur de règles. À aligner.
2. Le toggle regex (nouveau, n'existe nulle part) : sur les règles ET sur le
   filtre.

## Décisions (confirmées)

- **Scope** : toggle regex sur les deux surfaces (`/rules` + filtre
  `/transactions`) + alignement accents du filtre. `CLAUDE.md` dit
  aujourd'hui « pas de regex utilisateur » — à mettre à jour à la fin.
- **Accents** : insensible aux accents partout (aligné sur les règles).
  Techniquement impossible en SQL sur SQLite → quand `q` est présent, fetch
  les transactions du user avec les autres filtres SQL conservés
  (type/catégorie/mois/batch), puis filtre en JS via `normalizeForMatch`
  (contient) ou `RegExp` en try/catch (mode regex). Pas de `q` → reste 100%
  SQL comme aujourd'hui.
- **Sécurité regex** : validation statique à la création (compilation
  try/catch + rejet des quantificateurs imbriqués type `(a+)+` +
  borne de longueur existante ≤80). Pas de timeout runtime. La preview
  existante (`previewCategoryRules()`) sert déjà de garde-fou anti-sur-match
  — pas d'avertissement UI supplémentaire cette itération.
- **Migration règles existantes** : `isRegex Boolean @default(false)`, zéro
  changement de comportement, rien à migrer.
- Le rejet existant des caractères `<>` dans les patterns bloque la syntaxe
  lookbehind `(?<=...)` — limitation acceptée, à documenter dans le message
  d'aide du champ.

## Implémentation

### Schéma

- `prisma/schema.prisma` : ajouter `isRegex Boolean @default(false)` sur
  `CategoryRule`. Migration `npx prisma migrate dev --name category_rule_is_regex`.

### Moteur de matching (`src/lib/server/categorization/rules.ts`)

- Chemin « contient » (`normalizedContains`) reste le défaut, inchangé.
- Nouveau chemin regex : si `rule.isRegex`, compiler `new RegExp(...)` et
  tester sur le libellé normalisé (`normalizeForMatch`) pour rester
  accent-insensible de façon cohérente. Compilation en try/catch → règle
  regex invalide = ignorée silencieusement au matching (validée à la
  création ; défense en profondeur).
- `parseCategoryRuleInput()` : accepter le flag `isRegex` ; si vrai, valider
  le pattern (compilation + garde statique anti-quantificateurs imbriqués,
  nouvelle fonction `isSafeRegexPattern()` dans le même fichier). Le rejet
  `<>` existant reste (limitation lookbehind documentée dans le message
  d'aide, lookahead `(?=...)` non affecté).
- Propagation automatique aux 4 surfaces consommatrices (preview, apply,
  badge classifiable, suggestions) puisqu'elles passent toutes par
  `findMatchingCategoryRule()`.

### Filtre `/transactions`

- `src/lib/server/transactions/where.ts` +
  `src/routes/transactions/+page.server.ts` : quand `q` est présent, ne
  plus filtrer en SQL sur le libellé — fetch des transactions du user
  (autres filtres SQL conservés : type/catégorie/mois/batch) puis filtre JS
  via `normalizeForMatch` (contient) ou `RegExp` en try/catch (mode regex,
  param URL `qMode=regex`, regex invalide → zéro résultat + message).
  Pagination recalculée sur la liste filtrée.
- Extraire `normalizeForMatch` vers un module partagé
  (`src/lib/server/matching/normalize.ts`) — il existe en plusieurs copies
  privées ; n'en consolider que les 2 usages nécessaires ici (rules.ts + le
  nouveau filtre), pas les autres (hors scope).

### UI

- `/rules` (`+page.svelte`) : toggle « r » (bouton icône avant le champ,
  aria-pressed) pour le mode regex, champ `isRegex` dans les forms
  create/update. Mise à jour de `rules_subtitle` /
  `rules_modal_create_description` (fr+en) qui disent « sans regex ».
- `/transactions` : même toggle « r » avant le champ de recherche.
- Nouvelles clés Paraglide (fr+en) : libellé/aria du toggle, erreur
  « pattern regex invalide », note lookbehind non supporté.

### Documentation

- `CLAUDE.md` : remplacer « pas de regex utilisateur » par la nouvelle
  règle (contient par défaut, regex opt-in validée, jamais d'écrasement des
  corrections manuelles inchangé).

## Ce qui ne bouge pas

- Comportement des règles existantes (contient littéral, casse/accents) au
  bit près.
- `findMatchingCategoryRule()` ne matche jamais une transaction avec
  `manualCategory` (court-circuit conservé).
- Le chemin sans `q` du filtre transactions reste 100% SQL (pas de
  régression perf sur le cas courant).

## Vérification

1. Tests unitaires : `rules.spec.ts` (matching regex casse/accents,
   `isSafeRegexPattern` rejette `(a+)+`-style, contient littéral inchangé) ;
   filtre JS (contient accent-insensible « Depenses »→« Dépenses », regex,
   pagination recalculée) ; actions create/update avec `isRegex` (pattern
   invalide rejeté en 400).
2. `npx prisma migrate dev` + `npx prisma generate` &&
   `npm run check` && `npm run test:unit -- --run` — suite 100% verte (452
   tests actuels).
3. `code-reviewer` + `security-reviewer` (validation du pattern côté
   serveur, aucun contournement du scoping `userId` dans le nouveau chemin
   de filtre JS).
4. Manuel : créer une règle regex, preview, apply ; rechercher « Depenses »
   et trouver « Dépenses ».

## Fichiers touchés

`prisma/schema.prisma` (+migration), `src/lib/server/categorization/rules.ts`,
`src/lib/server/matching/normalize.ts` (nouveau),
`src/lib/server/transactions/where.ts`,
`src/routes/transactions/+page.server.ts`,
`src/routes/transactions/+page.svelte`, `src/routes/rules/+page.server.ts`,
`src/routes/rules/+page.svelte`, `messages/fr.json`, `messages/en.json`,
`CLAUDE.md`.

## Progression

- [x] Schéma + migration Prisma (`isRegex`)
- [x] Module partagé `matching/normalize.ts`
- [x] Moteur de matching : chemin regex + `isSafeRegexPattern` + propagation `parseCategoryRuleInput`
- [x] Filtre `/transactions` : chemin JS accent-insensible + regex + pagination (+ export CSV aligné, ajouté au scope : régression sinon)
- [x] UI `/rules` : toggle regex + clés Paraglide
- [x] UI `/transactions` : toggle regex + clés Paraglide
- [x] `CLAUDE.md` mis à jour
- [x] Tests (rules.spec.ts, search.spec.ts, page.server.spec.ts create/update/filtre) — 472 tests verts
- [x] `npx prisma generate && npm run check && npm run test:unit -- --run` 100% vert
- [x] `code-reviewer` + `security-reviewer`
- [x] Vérification manuelle (smoke test dev server : `/transactions`, `/rules`, `?q=auchan`, `?q=(&qMode=regex` — tous 303 propre vers login, aucun crash serveur, y compris sur regex invalide)

Note d'implémentation (écart mineur vs plan initial) : le mode regex du filtre
teste le pattern (flag `i`) directement sur le libellé brut, pas sur le
libellé normalisé accent-insensible — normaliser le _pattern_ casserait sa
syntaxe (classes de caractères, échappements). Limitation documentée dans le
message d'aide UI.

## Correctifs post-review (code-reviewer + security-reviewer, convergents)

Les deux reviewers ont indépendamment signalé la même lacune réelle : le mode
regex du filtre `/transactions` (`qMode=regex`, éphémère) n'avait **aucune**
garde anti-ReDoS, contrairement au moteur de règles persistées (`isSafeRegexPattern`
avec rejet des quantificateurs imbriqués). Un pattern catastrophique dans `q`
aurait pu geler l'event loop Node (mono-thread) pour **toute l'instance**, pas
seulement l'utilisateur requêtant — risque réel vu que l'app supporte plusieurs
comptes (`REGISTRATION_MODE=open`, `PUBLIC_INSTANCE=true`).

Corrigé :

- `src/lib/server/matching/regex.ts` (nouveau) : `isSafeRegexPattern(pattern, maxLength)`
  partagé (heuristique quantificateurs imbriqués + compilation try/catch),
  paramétré par la borne de longueur de chaque appelant (80 pour les règles,
  120 pour la recherche). `safeRegexTest(pattern, flags, value)` : borne aussi
  la chaîne **testée** à 300 caractères (`MAX_REGEX_TEST_INPUT_LENGTH`) — défense
  en profondeur contre les patterns qui passeraient la première heuristique
  (ex. chevauchement d'alternance, non détecté par le rejet de quantificateurs
  imbriqués).
- `rules.ts` (`ruleMatchesLabel`) et `transactions/search.ts` (`matchesQuery`,
  `isValidRegexQuery`) délèguent maintenant à ce module partagé — les deux
  moteurs de matching regex sont symétriques.
- `transactions/export/+server.ts` : un pattern regex invalide renvoie
  maintenant une erreur HTTP 400 explicite (`error(400, ...)`) au lieu de
  produire silencieusement un CSV vide (juste l'en-tête) sans signal à
  l'utilisateur — incohérence UX relevée par le code-reviewer.
- Tests ajoutés : rejet des quantificateurs imbriqués côté recherche
  (`search.spec.ts`), borne de longueur du libellé testé, 400 sur regex
  invalide à l'export, verrouillage `isRegex: false` sur le flux rapide
  "créer une règle depuis une transaction" (`page.server.spec.ts`).

Résidu accepté : l'heuristique anti-quantificateurs-imbriqués reste heuristique,
pas une garantie formelle anti-ReDoS (un moteur sans backtracking type RE2
serait plus robuste mais ajoute une dépendance non justifiée par le seuil de
risque actuel — app local-first, mono-utilisateur dans l'usage principal). La
borne de 300 caractères sur la chaîne testée limite le pire cas résiduel.
