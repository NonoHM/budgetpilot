-- i18n : la catégorie fallback n'est plus stockée en français ('Non catégorisé')
-- mais sous un slug technique neutre ('uncategorized'), résolu en libellé traduit
-- uniquement à l'affichage. Toutes les tables qui référencent une catégorie par
-- nom doivent suivre.
UPDATE "Category" SET "name" = 'uncategorized' WHERE "name" = 'Non catégorisé';
UPDATE "Transaction" SET "manualCategory" = 'uncategorized' WHERE "manualCategory" = 'Non catégorisé';
UPDATE "CategoryRule" SET "targetCategory" = 'uncategorized' WHERE "targetCategory" = 'Non catégorisé';
UPDATE "CategorizationRule" SET "targetCategory" = 'uncategorized' WHERE "targetCategory" = 'Non catégorisé';
UPDATE "MonthlyBudget" SET "categoryName" = 'uncategorized' WHERE "categoryName" = 'Non catégorisé';
UPDATE "CategoryNatureMapping" SET "categoryName" = 'uncategorized' WHERE "categoryName" = 'Non catégorisé';

-- Backfill defaultKey pour les catégories par défaut jamais renommées (nom FR
-- exact seedé par ensureDefaultCategoriesSeeded). Les catégories renommées ou
-- custom gardent defaultKey NULL (texte libre, jamais traduit).
UPDATE "Category" SET "defaultKey" = 'food' WHERE "name" = 'Alimentation' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'dining' WHERE "name" = 'Restauration' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'transport' WHERE "name" = 'Transport' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'housing' WHERE "name" = 'Logement' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'bills_energy' WHERE "name" = 'Factures & énergie' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'health' WHERE "name" = 'Santé' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'leisure' WHERE "name" = 'Loisirs' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'subscriptions' WHERE "name" = 'Abonnements' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'shopping' WHERE "name" = 'Shopping' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'travel' WHERE "name" = 'Voyage' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'income' WHERE "name" = 'Revenus' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'savings' WHERE "name" = 'Épargne' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'investment' WHERE "name" = 'Investissement' AND "defaultKey" IS NULL;
UPDATE "Category" SET "defaultKey" = 'other' WHERE "name" = 'Autres' AND "defaultKey" IS NULL;
