# Audit d'architecture — BudgetPilot

Audit en lecture seule, réalisé le 2026-07-03. Aucune modification de code. Toutes les
lignes citées sont vérifiées dans l'arborescence actuelle (`git log` HEAD = `0fb211b`).

---

## 1. Séparation des couches

**Verdict : à surveiller**

La majorité des `+page.server.ts` sont de la vraie orchestration (load → appel à
`src/lib/server/*` → mapping vue). Deux exceptions notables mélangent logique métier
et route :

- **`src/routes/transactions/+page.server.ts`** (652 lignes) contient des fonctions
  privées non exportées qui sont de la vraie logique métier, pas de l'orchestration :
  - `anonymizeDetailText()` (l.610-625) et `anonymizeReference()` (l.627-632) :
    règles regex d'anonymisation PII (masquage carte bancaire, références, longues
    suites de chiffres). C'est une politique de sécurité/confidentialité concrète,
    pas du mapping — elle devrait vivre dans `src/lib/server/transactions/` (ou un
    module dédié `anonymize.ts`) pour être testable isolément et réutilisable (l'export
    CSV `transactions/export/+server.ts` a probablement un besoin similaire à
    vérifier).
  - `resolveTransactionType()` (l.564-570) est un **doublon exact** de
    `getTransactionKind()` déjà exporté par `src/lib/domain/transaction.ts` (l.52-58) —
    même signature, même corps. Le fichier route redéfinit plutôt que d'importer.
  - `parseManualCategory()` / `parseManualNature()` (l.577-596) dupliquent la logique
    de validation déjà présente dans `nature.ts` (`normalizeCategoryName`,
    `parseTransactionNatureInput`) avec des règles très proches (regex anti-`<>`,
    longueur max) mais des constantes locales (`MAX_MANUAL_CATEGORY_LENGTH`,
    `MAX_MANUAL_NATURE_LENGTH`) distinctes de `MAX_CATEGORY_NAME_LENGTH` (nature.ts)
    et `MAX_BUDGET_CATEGORY_LENGTH` (budget/dashboard.ts) — trois plafonds de longueur
    différents pour un concept qui devrait avoir une seule source de vérité.
  - `getAllowedBankFields()` (l.634+) encode une allowlist métier de labels CSV
    bancaires en dur dans la route — c'est une règle de mapping d'import, pas de
    l'affichage.

- **`src/routes/settings/+page.server.ts`** (292 lignes) est globalement propre
  (orchestration : password change, backup export/import, suppression de compte) mais
  `detectRuntime()` (l.263) est un détail d'infra local, acceptable en l'état vu sa
  taille.

Les autres routes (`budgets`, `categories`, `rules`, `imports`, `import`, `reports`,
`admin`) restent de l'orchestration correcte : `load`/`actions` appellent des fonctions
de `src/lib/server/*` et font du mapping simple.

**Sens de dépendance domain → infra : OK, une seule fuite mineure et sans risque runtime.**
`src/lib/domain/takeawayLabels.ts:2` fait
`import type { Takeaway } from '$lib/server/reports/monthly'` — c'est un **import de
type uniquement** (effacé à la compilation, aucun code de `$lib/server` n'est
embarqué côté client), donc le sens de dépendance est inversé sur le plan structurel
mais sans conséquence runtime. À corriger proprement en migrant le type `Takeaway`
vers `src/lib/domain/` si on veut une séparation stricte, mais ce n'est pas un risque
en l'état. Tous les autres fichiers du dossier (`categories.ts`, `initials.ts`,
`colors.ts`, `natureLabels.ts`, `budget.ts`, `transaction.ts`) sont libres de toute
dépendance `$lib/server` ou `$app/*`.

---

## 2. Duplication connue à quantifier

### `normalizeForMatch()`

**Une seule définition réelle**, dans `src/lib/server/matching/normalize.ts:1`.
Elle est importée (pas copiée) par `src/lib/server/transactions/search.ts` et
`src/lib/server/categorization/rules.ts`. **Pas de duplication de code** ici — le
grep large sur "normalizeForMatch" remonte des fichiers qui _appellent_ la fonction
(nature.ts, monthly.ts, csv.ts, auth.ts, etc.), pas des copies de sa définition.
Si une revue précédente a compté "5 copies", elle a probablement compté les usages,
pas les définitions. **Constat corrigé : pas de duplication à consolider ici.**

### Normalisateurs de nom de catégorie — 2 vraies quasi-copies + 1 fonction homonyme sans rapport

1. **`normalizeCategoryName()`** — `src/lib/server/transactions/nature.ts:38-49`
   Trim + collapse espaces + rejet si vide/> `MAX_CATEGORY_NAME_LENGTH` (80) /
   caractères `<>`+contrôle.
2. **`normalizeBudgetCategoryName()`** — `src/lib/server/budget/dashboard.ts:339-351`
   **Corps quasi identique** (même regex de collapse, même limite 80 caractères via
   `MAX_BUDGET_CATEGORY_LENGTH`), avec **une divergence fonctionnelle réelle** : elle
   lève `error(400, ...)` si le nom normalisé == `UNCLASSIFIED_CATEGORY` (le sentinel
   système), ce que (1) ne fait pas.
   → **Consolidable, mais pas par simple fusion aveugle** : la garde anti-sentinel de
   (2) devrait être portée dans la version commune (elle est probablement souhaitable
   partout où on nomme une catégorie manuellement), sinon la fusion régresse une
   protection.
3. **`normalizeCategoryName()`** — `src/lib/server/backup/import.ts:19-21` — **même nom,
   sémantique totalement différente** : ne valide rien, migre l'ancien nom FR legacy du
   sentinel (`"Non catégorisé"`) vers le slug actuel `UNCLASSIFIED_CATEGORY` pour la
   compatibilité des exports pré-i18n. Ce n'est **pas** un doublon de (1)/(2) malgré le
   nom identique — le nommage partagé est trompeur et vaut la peine d'être renommé
   (ex. `migrateLegacyCategoryName`) pour éviter une fusion accidentelle future.

### `normalizeId()` — doublon réel, 4 occurrences, sûr à consolider

Regex `^[a-z0-9_-]{8,}$/i` + trim, **identique dans les 4 endroits** :

- `src/lib/server/transactions/where.ts:49` (exportée, `value: string | null`)
- `src/routes/rules/+page.server.ts:148` (privée, `value: string`)
- `src/routes/categories/+page.server.ts:203` (privée, `value: string`)
- `src/lib/server/transactions/nature.ts:127-129` (inline dans
  `deleteCategoryNatureMapping`, même regex, non extraite en fonction)

Les 3 premières sont **fonctionnellement identiques** (seule la signature
nullable diffère) — consolidables sans risque vers un seul export (ex.
`src/lib/server/ids.ts` ou réexport de celle de `where.ts`).

### `resolveTransactionType()` / `getTransactionKind()`

Confirmé comme doublon exact (voir section 1) — `src/routes/transactions/+page.server.ts:564-570`
vs `src/lib/domain/transaction.ts:52-58`. Corps identique caractère pour caractère.
**Consolidable sans risque** : remplacer l'usage local par l'import du domaine.

### Autres duplications repérées (non mentionnées dans le prompt)

- **Trois plafonds de longueur de nom de catégorie divergents** (déjà relevé ci-dessus) :
  `MAX_CATEGORY_NAME_LENGTH=80` (nature.ts), `MAX_BUDGET_CATEGORY_LENGTH=80`
  (budget/dashboard.ts), `MAX_MANUAL_CATEGORY_LENGTH` (transactions/+page.server.ts,
  valeur non vérifiée ici mais définie séparément). Même si les valeurs numériques
  convergent aujourd'hui (80), ce sont trois constantes indépendantes qui peuvent
  diverger silencieusement à la prochaine modification.
- **`isPrismaUniqueError()`** apparaît dans `src/routes/categories/+page.server.ts:208`
  et une variante `isUniqueConstraintError()` dans `src/routes/import/+page.server.ts:328`
  — même intention (détecter une violation de contrainte unique Prisma), noms et
  probablement implémentations différentes ; à vérifier si elles testent le même code
  d'erreur Prisma (`P2002`) de la même façon.
- **`isUploadedFile()`** dupliqué entre `src/routes/settings/+page.server.ts` (import
  implicite via `existsSync`? à vérifier) et `src/routes/import/+page.server.ts:337` —
  garde de type `FormDataEntryValue` → `File`, probablement identique partout où un
  upload est traité.
- **`getFormValue()`** réimplémentée dans au moins 5 fichiers (`transactions`,
  `rules`, `categories`, `budgets`, `import` `+page.server.ts`) — pattern trivial
  (`formData.get(key)` avec garde `typeof === 'string'`) mais dupliqué à l'identique
  partout au lieu d'un helper partagé `src/lib/server/forms.ts`.

---

## 3. Taille et responsabilité des fichiers

Fichiers non-spec de plus de 400 lignes (routes + lib) :

| Fichier                                                            | Lignes                                      | Responsabilité unique ?                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/transactions/+page.server.ts`                          | 652                                         | **Non** — load/actions/mapping + anonymisation PII + validation manuelle + allowlist CSV bancaire (voir section 1). Candidat prioritaire à scinder.                                                                                                                                                                               |
| `src/routes/settings/+page.server.ts`                              | 292 (sous le seuil, mentionné pour mémoire) | Oui globalement — auth (password/sessions) + backup + compte, mais tout appelle des modules `server/*` dédiés. Le seul mélange est `detectRuntime()`, mineur.                                                                                                                                                                     |
| `src/routes/import/+page.server.ts`                                | 365                                         | Oui, cohérent — tout tourne autour de l'action d'import (persist, anonymisation preview CSV, gestion d'erreurs fichier). Anonymisation dupliquée avec `transactions/+page.server.ts` à vérifier (fonctions `anonymizeCsvRowPreview`/`anonymizeCell` vs `anonymizeDetailText`/`anonymizeReference` — noms différents, à comparer). |
| `src/routes/settings/+page.svelte`                                 | 803                                         | UI seule, hors périmètre logique métier mais gros fichier Svelte — candidat à la passe responsive/dette technique déjà planifiée.                                                                                                                                                                                                 |
| `src/routes/transactions/+page.svelte`                             | 863                                         | Idem, UI seule.                                                                                                                                                                                                                                                                                                                   |
| `src/routes/reports/+page.svelte`                                  | 610                                         | UI seule.                                                                                                                                                                                                                                                                                                                         |
| `src/lib/server/budget/dashboard.ts`                               | 436                                         | Oui — logique budget cohérente (parsing montant, mapping nature, CRUD budgets), mélange léger validation (`normalizeBudgetCategoryName`) + logique métier, acceptable à cette taille.                                                                                                                                             |
| `src/lib/server/reports/monthly.ts`                                | 347                                         | Oui, cohérent (agrégation mensuelle).                                                                                                                                                                                                                                                                                             |
| `src/lib/server/categorization/rules.ts`                           | 320                                         | Oui, cohérent (matching de règles).                                                                                                                                                                                                                                                                                               |
| `src/lib/server/import/profiles/banque-populaire.ts`, `revolut.ts` | 242-243                                     | Oui, un profil = un fichier, sous le seuil mais mentionné car proche.                                                                                                                                                                                                                                                             |

**Verdict : à corriger** pour `transactions/+page.server.ts` — c'est le seul fichier
qui dépasse nettement le seuil _et_ mélange plusieurs responsabilités distinctes
(orchestration route + anonymisation PII + validation métier + policy CSV bancaire).
Les gros `.svelte` sont hors du périmètre "séparation des couches backend" et relèvent
de la passe responsive déjà planifiée dans le backlog.

---

## 4. Modularité des features optionnelles/sensibles

**Verdict : ok**

- **Ollama / IA** : imports concentrés. `src/lib/server/insights/local-llm.ts` est le
  seul point d'appel réseau. Les seuls fichiers routes qui touchent au flag sont
  `src/routes/+page.server.ts` (affichage carte insight) et
  `src/routes/settings/+page.server.ts` (toggle utilisateur + affichage
  `llmEnabled`/`llmGloballyEnabled`). Pas de conditionnel `LLM_ENABLED` dispersé
  ailleurs — conforme à la description CLAUDE.md (gating centralisé).
- **Backup/restore** : concentré dans `src/lib/server/backup/{export,import,schema}.ts`
  - point d'entrée route unique `src/routes/settings/+page.server.ts` et
    `src/routes/settings/export/+server.ts`. Pas de duplication de la logique de
    restauration ailleurs.
- **i18n (Paraglide)** : usage via `import * as m from '$lib/paraglide/messages'`,
  cohérent dans tous les fichiers grep-és plus haut — pas de mécanisme de traduction
  parallèle détecté en dehors de `categoryLabel()`/`categoryLabelByName()` (déjà
  documenté comme volontaire dans CLAUDE.md).

Aucun signal de dispersion excessive pour ces trois features.

---

## 5. Testabilité

**Verdict : à surveiller**

Fichiers `.ts` de `src/lib/domain/` et `src/lib/server/` **sans fichier `.spec.ts`
correspondant** (33 fichiers non-spec au total dans ces deux dossiers, listés
ci-dessous — certains sont des types purs ou de la config, pas de la logique à tester) :

```
src/lib/domain/categories.ts        (constantes — faible besoin de test)
src/lib/domain/natureLabels.ts      (lookup trivial — faible besoin)
src/lib/domain/colors.ts            (constantes — faible besoin)
src/lib/domain/transaction.ts       (contient getTransactionKind, validateTransaction — LOGIQUE, non testée directement)
src/lib/server/db.ts                (config Prisma — pas de logique)
src/lib/server/matching/normalize.ts (normalizeForMatch — LOGIQUE non triviale, non testée directement, seulement via ses appelants)
src/lib/server/matching/regex.ts    (isSafeRegexPattern — LOGIQUE sécurité, non testée directement)
src/lib/server/insights/rules.ts, types.ts, prompt.ts  (rules.ts = logique déterministe des insights, pas de spec dédié — testé seulement via index.spec.ts ?)
src/lib/server/backup/import.ts, export.ts  (LOGIQUE sensible — testée via backup.spec.ts au niveau intégration, pas de spec unitaire par fichier)
src/lib/server/import/registry.ts, types.ts
src/lib/server/banking/connectors/types.ts
src/lib/server/import/utils/money.ts, csv.ts, encoding.ts, safety.ts  (LOGIQUE de parsing/anonymisation — testée via import/csv.spec.ts au niveau agrégé)
src/lib/server/import/profiles/revolut.ts, banque-populaire.ts, generic.ts
```

Points concrets non testables isolément (couplage à l'infra ou absence d'export) :

- `anonymizeDetailText()` / `anonymizeReference()` dans
  `transactions/+page.server.ts` : **non exportées**, donc impossibles à unit-tester
  sans passer par une action SvelteKit complète (`page.server.spec.ts` ne les importe
  pas directement — vérifié par grep). C'est la même logique de masquage PII que
  celle qui _devrait_ être extraite (section 1) — l'extraire résoudrait aussi ce
  problème de testabilité.
- `isSafeRegexPattern()` (`matching/regex.ts`) est une fonction de sécurité (anti-ReDoS
  pour les règles regex opt-in) sans fichier de test dédié visible — elle est
  couverte indirectement via `rules.spec.ts` probablement, mais une fonction de cette
  criticité (mentionnée comme durcissement sécurité dans CLAUDE.md) mériterait un
  spec dédié avec des cas adversariaux explicites (quantificateurs imbriqués, etc.)
  plutôt qu'une couverture incidente.

Les modules avec `.spec.ts` correspondant (nature.ts, rules.ts, where.ts,
dashboard.ts, monthly.ts, auth.ts, rateLimit.ts, csv.ts, backup, insights/\*) sont
en bonne proportion testés indépendamment du contexte SvelteKit (imports directs de
fonctions, pas de montage de route) — c'est la majorité du volume de logique.

---

## 6. Extensibilité — test concret

### Scénario A : ajouter une nouvelle nature de transaction (ex. `donation`)

Fichiers à toucher, en listant uniquement ceux qui contiennent une énumération
exhaustive des natures (pas les simples `import type TransactionNature`) :

1. `src/lib/domain/transaction.ts` — ajouter au type union + au tableau des valeurs valides
2. `src/lib/domain/natureLabels.ts` — ajouter la clé au `NATURE_LABELS` record
3. `src/lib/domain/colors.ts` — ajouter une couleur dans `NATURE_COLORS`
4. `src/lib/server/transactions/nature.ts` — `NATURE_DEFAULT_BY_KIND` si mapping par défaut concerné
5. `messages/fr.json` + `messages/en.json` — ajouter `nature_donation` (2 fichiers, i18n)
6. Potentiellement `src/lib/server/categories/defaults.ts` si une catégorie par défaut doit mapper vers cette nature

Soit **~6-7 fichiers**, dont 2 sont juste des paires de traduction JSON. Le compilateur
TypeScript **force** la mise à jour de tous les `Record<TransactionNature, ...>`
(erreur de compilation si une clé manque) — c'est un signal positif : le typage
exhaustif limite le risque d'oubli malgré la dispersion. **Sous le seuil de 8-10
fichiers, pas de signal de couplage excessif.**

### Scénario B : ajouter un nouveau mode de matching de règle (ex. `startsWith`, en plus de `contains`/`isRegex`)

Fichiers à toucher :

1. `prisma/schema.prisma` — étendre `CategoryRule` (nouveau champ ou enum de mode) + migration
2. `src/lib/server/matching/normalize.ts` ou nouveau module pour la logique `startsWith`
3. `src/lib/server/categorization/rules.ts` — `findMatchingCategoryRule()`, `ruleMatchesLabel()`
4. `src/lib/server/transactions/search.ts` — le filtre libellé `/transactions` doit répliquer le même comportement (documenté comme couplage volontaire dans CLAUDE.md : "suit le même comportement")
5. `src/routes/rules/+page.server.ts` — actions create/update de règle
6. `src/routes/rules/+page.svelte` — UI de sélection du mode
7. `src/routes/transactions/+page.server.ts` — si le filtre `qMode` expose aussi ce mode
8. `src/routes/transactions/+page.svelte` — UI du filtre
9. `src/routes/transactions/export/+server.ts` — l'export CSV doit respecter le même filtre (mentionné dans CLAUDE.md)

Soit **9 fichiers** pour une feature qui, par construction (le filtre `/transactions`
duplique intentionnellement le comportement des règles), touche deux surfaces
utilisateur distinctes. C'est **au-dessus du seuil indicatif de 8-10** mais la cause
est documentée et assumée (CLAUDE.md précise explicitement que le filtre suit le même
comportement que les règles) plutôt qu'un couplage accidentel — à noter comme
signal faible, pas comme dette cachée.

---

## Synthèse priorisée

Si l'objectif est une base "industry grade", dans cet ordre de priorité :

1. **[À corriger] Extraire la logique métier de `transactions/+page.server.ts`**
   (652 lignes) : anonymisation PII (`anonymizeDetailText`/`anonymizeReference`) vers
   un module testable dédié, suppression du doublon `resolveTransactionType` au
   profit de `getTransactionKind()` du domaine, unification de la validation manuelle
   de catégorie avec `nature.ts`. C'est le seul fichier qui cumule taille excessive +
   mélange de responsabilités + logique de sécurité (PII) non unit-testable.

2. **[À corriger] Consolider `normalizeId()`** (4 occurrences identiques) en un seul
   export partagé — gain immédiat, risque nul, améliore la testabilité d'un coup.

3. **[À surveiller] Unifier les 3 plafonds de longueur de nom de catégorie**
   (`MAX_CATEGORY_NAME_LENGTH`, `MAX_BUDGET_CATEGORY_LENGTH`, `MAX_MANUAL_CATEGORY_LENGTH`)
   et les deux `normalizeCategoryName`/`normalizeBudgetCategoryName` quasi-identiques,
   **en conservant explicitement** la garde anti-sentinel de la version budget lors de
   la fusion. Renommer le `normalizeCategoryName` de `backup/import.ts` (sémantique de
   migration legacy, pas de validation) pour lever l'ambiguïté de nommage.

4. **[À surveiller] Ajouter des specs dédiés** pour les fonctions de sécurité isolées
   qui n'en ont pas explicitement : `isSafeRegexPattern()` (anti-ReDoS) et, après
   extraction du point 1, les fonctions d'anonymisation PII — ce sont des fonctions à
   fort enjeu sécurité/vie privée qui méritent des cas de test adversariaux explicites
   plutôt qu'une couverture incidente via des specs de plus haut niveau.

5. **[Info, pas de risque avéré] Le reste est globalement sain** : le sens de
   dépendance domaine → infra est respecté, les features optionnelles (Ollama,
   backup, i18n) sont bien isolées, et le scénario d'extension "nouvelle nature" reste
   sous le seuil de couplage grâce au typage exhaustif TypeScript. Le cas "nouveau
   mode de matching" dépasse légèrement le seuil mais pour une raison documentée et
   volontaire (comportement partagé rules/transactions), pas un signal de dette cachée.
