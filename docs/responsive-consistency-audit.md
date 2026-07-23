# Audit de cohérence responsive — 9 pages

Passe de vérification finale après le chantier responsive complet
(dashboard, transactions, budgets, reports, rules, categories, settings,
import/imports, admin). Aucune correction appliquée — constat uniquement,
priorisé du plus visible au plus mineur.

État au moment de l'audit : `admin/+page.svelte` + `messages/{fr,en}.json`
ont des modifications non commitées (version mobile de `/admin` tout juste
ajoutée) — auditées telles quelles.

## TL;DR (les 8 points qui comptent)

1. **Bug i18n visible** : `categories/+page.svelte:126` et `:323` — deux
   chaînes hardcodées en français (`'Aucune'`, `'Nom'`) dans la version
   desktop alors que les clés Paraglide existent déjà
   (`categories_nature_none`, `categories_name_label`) et sont utilisées
   correctement côté mobile de la même page. Un utilisateur EN voit du
   français dans le select "nature" et le formulaire de création desktop.
2. **`/import` desktop ne réutilise pas `FileDropZone`** : le composant
   partagé existe et supporte déjà un rendu desktop (`desktopInputClass`,
   utilisé par `/settings`), mais la section desktop de `/import` (ligne
   73-82) a un `<input type="file">` stylé à la main, dupliquant ce que
   `FileDropZone` fait déjà pour mobile juste en dessous dans le même
   fichier.
3. **Badge de rôle ADMIN/USER incohérent entre desktop et mobile sur la
   même page** : `/admin` mobile (ajout non commité) introduit un badge
   plein noir pour ADMIN vs bordure outline pour USER (lignes 261-273),
   mais le tableau desktop (lignes 114-119) garde un badge neutre unique
   `bg-zinc-100 text-zinc-600` peu importe le rôle. Le nouveau pattern
   n'a pas été reporté sur la version desktop de la même page — c'est
   une régression de cohérence _interne_ introduite par le chantier
   lui-même, pas juste un legacy oublié.
4. **`ListCard` (rounded-2xl) diverge de la convention card mobile
   dominante (rounded-3xl + shadow-sm)** utilisée partout ailleurs
   (rules, categories, imports, admin, budgets). `/transactions` est la
   seule page mobile dont les cartes de liste sont `rounded-2xl` sans
   `shadow-sm` — repérable au premier coup d'œil si on navigue
   transactions → rules par exemple.
5. **`BudgetStatusCard` badge de statut vs pattern ADMIN plein/outline** :
   les badges `ok/near_limit/over_budget` restent en teintes pastel
   pleines (`bg-emerald-100/amber-100/rose-100`), ce qui est correct
   _sémantiquement_ (sévérité ≠ identité) — mais du coup le nouveau
   pattern "plein = état fort, outline = état neutre" introduit sur
   `/admin` n'est appliqué nulle part ailleurs qu'à ce badge de rôle : à
   trancher explicitement si c'est un pattern isolé ou à généraliser.
6. **Boutons secondaires desktop `/admin`** (reset mot de passe /
   suppression) sont restés en texte simple sans style bouton
   (lignes 126-140), alors que les autres pages (rules, categories,
   budgets) ont depuis converti leurs actions de ligne en `Button
variant="ghost"/"ghost-danger"` — `/admin` desktop n'a pas reçu cet
   ajustement décidé plus tard dans le chantier, bien qu'il ait été
   retouché très récemment (diff en cours) pour autre chose.
7. **Formulation "reste/dépassement" à vérifier dans `BudgetStatusCard`
   plain variant (dashboard)** — la variante `plain` masque le badge de
   statut texte mais conserve la couleur du delta, cohérent ; pas de
   dérive détectée ici, mentionné pour mémoire (voir section 3).
8. **Zone tactile ≥44px** globalement bien respectée y compris sur
   dashboard/transactions (les pages les plus anciennes du chantier) —
   un seul écart mineur relevé : les liens texte inline sans padding
   (ex. "Voir tout" dashboard, "Gérer les catégories" transactions) n'ont
   pas de hit-area 44px, mais ce sont des liens secondaires texte, pas
   des actions primaires — à confirmer si le seuil doit s'appliquer aux
   liens texte ou seulement aux boutons/icônes.

---

## 1. Bugs visibles par l'utilisateur (priorité haute)

### 1.1 Chaînes hardcodées en français dans `/categories` desktop

- `src/routes/categories/+page.svelte:126` :
  `{ value: '', label: 'Aucune' }` — devrait être
  `m.categories_nature_none()`, comme fait correctement à la ligne 261
  (bloc mobile de la **même page**).
- `src/routes/categories/+page.svelte:323` : `Nom` en dur dans le label
  du champ de création de catégorie — la clé `categories_name_label`
  existe déjà (`messages/fr.json:122` / `en.json:122`) mais n'est pas
  utilisée ici.
- Impact : un utilisateur en locale `en` voit du français dans le select
  "nature" du tableau desktop et dans la modale de création. Contredit
  directement la règle CLAUDE.md "nouvelles features doivent utiliser
  Paraglide dès l'écriture" — ici c'est une régression sur du code déjà
  migré, pas une nouvelle feature, donc plus surprenant.

### 1.2 `/import` : le composant `FileDropZone` partagé n'est pas utilisé en desktop

- `src/routes/import/+page.svelte:73-82` (section desktop) : input file
  natif stylé à la main (`rounded-md border border-zinc-300 ...`).
- `src/routes/import/+page.svelte:216-223` (section mobile, même
  fichier) : utilise `<FileDropZone>` correctement.
- `FileDropZone.svelte` supporte déjà un rendu desktop natif (`sr-only
lg:not-sr-only lg:block`, prop `desktopInputClass` déjà exploitée par
  `/settings` ligne 607) — donc rien ne justifie techniquement que
  `/import` desktop n'en bénéficie pas. Duplication de logique
  équivalente entre deux endroits du même fichier, contraire à la
  posture d'architecture CLAUDE.md ("aucune logique métier dupliquée...
  si une fonction équivalente existe déjà, l'importer").
- Effet visuel : le style du champ fichier diverge entre desktop
  (bordure pleine grise standard) et mobile (zone en pointillés avec
  icône) sur la même action, alors que `/settings` a un seul composant
  qui gère élégamment les deux tailles.

### 1.3 Badge de rôle ADMIN/USER — desktop vs mobile sur `/admin`

- Desktop (`admin/+page.svelte:114-119`) : un seul style de badge neutre
  `bg-zinc-100 text-zinc-600` pour tous les rôles.
- Mobile, ajouté dans les modifications en cours (`admin/+page.svelte:
261-273`) : ADMIN → badge plein noir (`bg-zinc-900 text-white`), USER →
  badge outline (`border border-zinc-200 text-zinc-600`).
- C'est exactement le pattern que le prompt de l'utilisateur demande de
  vérifier ("le nouveau pattern ADMIN plein/USER outline introduit sur
  /admin devrait-il s'appliquer ailleurs ?") — mais il ne s'applique même
  pas de façon cohérente **au sein de la même page** entre desktop et
  mobile. Recommandation : reporter le style plein/outline sur le
  tableau desktop pour fermer cet écart avant de se demander si le
  pattern doit se propager plus loin.

## 2. Dette de code / duplication

### 2.1 `ListCard` (rounded-2xl) vs convention card mobile dominante (rounded-3xl)

- `src/lib/components/ui/ListCard.svelte:25` : `rounded-2xl border
border-zinc-200 bg-white shadow-sm` — sans variante `lg:` puisque le
  composant n'est utilisé que sous `lg:hidden`.
- Toutes les autres implémentations de "carte liste mobile" utilisent
  `rounded-3xl ... shadow-sm` : `rules/+page.svelte:344`,
  `categories/+page.svelte:215`, `imports/+page.svelte:166`,
  `admin/+page.svelte:256`, `budgets` via `BudgetStatusCard` (`rounded-3xl
... lg:rounded-lg`).
- `/transactions` est la seule page à utiliser `ListCard`, et donc la
  seule dont les cartes de transaction ont un rayon de coin plus petit
  que le reste de l'app. Sous-composants internes de `/transactions`
  (bandeau "à classer" ligne 239, proposition mobile ligne 1020, résumé
  bottom-sheet ligne 1259) utilisent aussi `rounded-2xl`, cohérents entre
  eux mais pas avec le standard "carte principale" des 8 autres pages.
- Ce n'est probablement pas une régression involontaire (les usages de
  `rounded-2xl` dans `/transactions` semblent être un choix délibéré de
  hiérarchie — carte principale vs sous-bloc), mais `ListCard` lui-même
  étant LE composant partagé "remplacement mobile de ligne de tableau",
  son rayon de coin devrait probablement matcher `rounded-3xl` pour
  rester cohérent avec `rules`/`categories`/`imports`/`admin` qui
  implémentent la même idée à la main.

### 2.2 Boutons d'action de ligne `/admin` desktop restés en texte simple

- `admin/+page.svelte:126-140` (desktop) : `<button class="text-sm
font-medium text-zinc-600 hover:text-zinc-900">` / texte rose pour
  supprimer — pas de composant `Button`.
- Comparer à `rules/+page.svelte:221-222` et `categories/+page.svelte:
147-158` (desktop) qui utilisent `<Button variant="ghost" />` /
  `<Button variant="ghost-danger" />` pour les actions de ligne
  équivalentes (éditer/supprimer).
- `/admin` mobile (diff en cours) utilise bien `<Button variant=
"secondary">` pour le reset, mais garde un `<button>` texte brut pour
  la suppression (ligne 296-302) — cohérent avec le choix "bouton
  destructif en texte simple" documenté dans le prompt utilisateur
  ("boutons destructifs en texte simple vs bouton plein selon la
  gravité"), donc ce choix précis est correct. C'est le bouton non
  destructif desktop (reset mot de passe, ligne 126-132) qui n'a pas été
  aligné sur le pattern `Button variant="ghost"` généralisé ailleurs.

## 3. Détails mineurs

### 3.1 Liens texte inline sans zone tactile 44px

- Exemples : `m.dashboard_view_all()` (`+page.svelte:267`),
  `m.transactions_manage_categories_link()` (`transactions/+page.svelte:
807`), `m.dashboard_view_all_transactions()` (`+page.svelte:310`).
- Aucun n'a de `min-h-[44px]` ni de padding généreux. Ce sont des liens
  secondaires texte (pas des boutons ni icônes seules), donc l'écart
  avec la règle "zone tactile ≥44px sur tout élément cliquable sans
  bordure visible" est probablement acceptable pour du texte inline
  court en fin de paragraphe — mais à trancher explicitement puisque
  d'autres liens comparables ailleurs (ex. `transactions_reset_filters_
link` ligne 1130) sont dans le même cas sans qu'aucune règle écrite
  ne les exempte formellement.

### 3.2 Espacement `gap-3`/`gap-4` — pas de dérive significative

- Les containers de listes mobiles utilisent systématiquement
  `space-y-3` (rules, categories, imports, admin, transactions) — une
  seule valeur dominante, cohérent.
- Les sections de formulaire (`space-y-4`) sont elles aussi cohérentes
  entre `categories`, `rules`, `settings`. Pas de dérive à signaler.

### 3.3 Ombres et bordures — cohérent

- Toutes les cartes mobiles suivent `rounded-3xl ... shadow-sm` (sauf
  `ListCard`, cf. 2.1) et toutes les cartes desktop `rounded-lg`/
  `rounded-md border border-zinc-200 shadow-none` — cohérence confirmée
  sur les 9 pages pour ce point précis.

### 3.4 Navigation bas — cohérente

- `AppNav.svelte` : bottom nav mobile = 4 items fixes (dashboard,
  transactions, budgets, reports) + "Plus" (rules, imports) = bien 5
  entrées visibles au total comme attendu. `isMoreActive` couvre
  correctement rules/imports pour l'état actif du bouton "Plus"
  (`AppNav.svelte:43`). Aucune page parmi les 9 n'a d'état actif
  incorrect détecté (chaque route passe la bonne clé `active` — non
  vérifié pour `/categories`, `/admin`, `/settings` qui ne sont pas dans
  `items`/`tabItems`/`moreItems` : ces 3 pages n'apparaissent dans aucun
  onglet de nav, accessibles uniquement via `AccountMenu` — cohérent
  avec la description CLAUDE.md de la nav à 6 liens fixes + menu compte).

### 3.5 Formulations montants/dates — pas de dérive détectée

- `formatCents`, `formatBudgetDelta` utilisés uniformément partout où
  des montants sont affichés (aucune page ne recalcule un format
  manuellement).
- Année affichée seulement si ≠ année courante : logique retrouvée à
  l'identique dans `transactions/+page.svelte:97-102`
  (`CURRENT_YEAR`) — pas de duplication ni de divergence trouvée
  ailleurs (les autres pages n'affichent pas de dates avec ce
  comportement conditionnel, donc pas de comparaison possible).

---

## Composants vérifiés — état d'usage

| Composant                          | Usage attendu                                                                           | Cohérent ?                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Switch.svelte`                    | rules (toggle règle), settings (IA)                                                     | Oui, deux usages, API identique                                                                       |
| `FileDropZone.svelte`              | import (mobile only, cf. 1.2), settings (desktop+mobile)                                | **Non** — import desktop ne l'utilise pas                                                             |
| `BudgetStatusCard.svelte`          | budgets (card+plain), dashboard (plain)                                                 | Oui                                                                                                   |
| `ListCard.svelte`                  | transactions uniquement                                                                 | Oui en interne, rayon divergent (cf. 2.1)                                                             |
| `inputSearchPill`                  | rules, transactions                                                                     | Oui                                                                                                   |
| `inputBase`/`inputFilter`          | quasi toutes les pages avec formulaire                                                  | Oui                                                                                                   |
| `CATEGORY_PALETTE`/`NATURE_COLORS` | reports (segments), transactions/categories (couleur stable via `resolveCategoryColor`) | Oui, deux mécanismes distincts et documentés (index vs hash), pas une duplication mais un choix voulu |
