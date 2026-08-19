-- The five predefined rules whose brand name is a prefix of an everyday French word. The
-- catalogue matches by substring, so `boulanger` (the electronics retailer) claimed every
-- BOULANGERIE and a bakery was filed under Shopping. The catalogue ships word-boundary patterns
-- now; this brings the rows already seeded into existing installs along with it, because
-- `createMissingDefaultRules` only ever CREATES what is missing and would leave them behind.
--
-- ONE statement, deliberately. `prisma migrate deploy` wraps nothing in a transaction on any
-- engine, so a migration whose safety needs all-or-none has to be a single statement.
--
-- Explicit target values through CASE rather than string concatenation: the new pattern is written
-- literally, instead of being assembled by three different concat syntaxes.
--
-- TWO guards, and both are load-bearing. `defaultRuleKey` is set to NULL the moment a user edits a
-- rule (see the schema comment on that column), so a non-null key means this row is still the one
-- we seeded. `matchText` still holding the original pattern means nothing else has rewritten it.
-- Together: the row is ours and untouched, so replacing it destroys no user intent.
--
-- Idempotent by construction: after the update the value is no longer in the IN list below.

UPDATE `CategoryRule`
SET `matchText` = CASE `defaultRuleKey`
        WHEN 'shopping_boulanger' THEN '\\bboulanger\\b'
        WHEN 'food_cora' THEN '\\bcora\\b'
        WHEN 'food_spar' THEN '\\bspar\\b'
        WHEN 'transport_esso' THEN '\\besso\\b'
        WHEN 'bills_orange' THEN '\\borange\\b'
        ELSE `matchText`
    END,
    `isRegex` = 1
WHERE `defaultRuleKey` IN ('shopping_boulanger', 'food_cora', 'food_spar', 'transport_esso', 'bills_orange')
  AND `matchText` IN ('boulanger', 'cora', 'spar', 'esso', 'orange');
