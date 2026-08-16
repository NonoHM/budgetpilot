# Changelog

## [0.12.1](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.12.0...budgetpilot-v0.12.1) (2026-08-16)


### Features

* **import:** the designation screen draws its file at 1280 and keeps the desktop chrome ([#367](https://github.com/NonoHM/budgetpilot/issues/367)) ([a3e289f](https://github.com/NonoHM/budgetpilot/commit/a3e289fa7bcda6e9c200279ad61c7be906ba6c3a))


### Maintenance

* release as 0.12.1 rather than 0.13.0 ([#369](https://github.com/NonoHM/budgetpilot/issues/369)) ([112fcfb](https://github.com/NonoHM/budgetpilot/commit/112fcfbfbfd3b4db87cc2ca52948f0ba85e1e56a))

## [0.12.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.11.2...budgetpilot-v0.12.0) (2026-08-16)

**This release is about one thing: importing a bank statement BudgetPilot does not recognise.**
The list below is thirty-odd commits; four of them change what happens to your money, and those
four are worth reading before you upgrade.

### If you import statements, read this

**A statement re-imported through different columns used to double your figures silently. It now
warns.** Duplicate detection compares the columns you designated, so the same statement read a
second time under a different label column produced a second set of transactions, reported as an
ordinary success. If two of your imports already overlap, the app now names them instead of
adding to the pile. Check `/imports` for two runs of the same file if you imported anything twice
since 0.11.

**Remembered column choices can now be removed.** BudgetPilot remembers one answer per header
shape, and until now nothing deleted one — with a cap on how many you may hold, that meant a user
who reached it could never import a new bank again. `Paramètres` has the list, one row per
correspondance, with a `Oublier` action. Removing one leaves every transaction it ever produced
in place; it removes the answer, not the history.

**A statement with no header row no longer loses its first transaction.** If your export starts
straight into data, tick « la première ligne contient des données » on the designation screen.
Before this release that answer never reached the parser, so the first row was read as a title and
silently dropped, on every import of that file.

**Dates written `01.06.2026` now import.** Day first, as the German, Swiss and Austrian convention
writes them. And when a date still cannot be read, the refusal says what it read and what it
wanted — « date non reconnue : « 01/06/26 » (attendu : JJ/MM/AAAA ou AAAA-MM-JJ) » — on all four
profiles rather than three.

### Also worth knowing

- **`Libellé` resolves.** The alias table folds accents, so the commonest French label header is
  no longer refused.
- **A file that refuses every row now offers the designation screen**, not just a file whose
  headers were unrecognised. Those two look identical from the outside and only one used to come
  with a way forward.
- **A page of identical refusals is one line and a count**, with the lines behind a reveal. The
  offer to fix your columns is no longer pushed below twenty-five copies of one sentence.
- **Revolut reads its English export**, and a statement declaring a non-euro currency is refused
  rather than relabelled.

### Known, and not fixed here

A date cell carrying two dates — `01/01/2026-01/01/2025`, as a « période » column might — imports
as the first of them without complaint (#366). Every impossible date is still refused; it is only
a cell holding more than one date that slips through. Filed with its measurement rather than
patched at the last moment, because the narrow fix risks the timestamp suffix that Revolut and
others legitimately write.

### Upgrading

No migration decision to make and no configuration change. The schema gains the column-mapping
table's link, applied by `prisma migrate deploy` as usual, and verified on SQLite, PostgreSQL 17
and MariaDB 11.



### Features

* **import:** 1280, as one control surface wearing a second chrome ([#333](https://github.com/NonoHM/budgetpilot/issues/333)) ([9ab1fce](https://github.com/NonoHM/budgetpilot/commit/9ab1fceb9e4b745f35a3a4967c725ef8a4d7bf8a))
* **import:** a file may declare at most 512 columns, for the screen rather than the parser ([#325](https://github.com/NonoHM/budgetpilot/issues/325)) ([1bda99c](https://github.com/NonoHM/budgetpilot/commit/1bda99cc017098d60ff320905be789e107d68f50))
* **import:** a file nothing recognises imports through the columns the user designated ([#328](https://github.com/NonoHM/budgetpilot/issues/328)) ([70de4cb](https://github.com/NonoHM/budgetpilot/commit/70de4cba10c9f92f9e9a426b8a9314fdb41a7b70))
* **import:** generic resolves its columns by alias, so real bank statements import ([#309](https://github.com/NonoHM/budgetpilot/issues/309)) ([9cb1daf](https://github.com/NonoHM/budgetpilot/commit/9cb1dafc56b4eaf4f553c0fd755fafebaab25cd0))
* **import:** the 390 designation screen, its picker, and the action that re-derives its own header list ([#330](https://github.com/NonoHM/budgetpilot/issues/330)) ([09e2368](https://github.com/NonoHM/budgetpilot/commit/09e2368b5d3149179c8bf87b705370cb1527da68))
* **import:** the column mapping model, on three migration histories, with both write paths guarded ([#327](https://github.com/NonoHM/budgetpilot/issues/327)) ([b366370](https://github.com/NonoHM/budgetpilot/commit/b3663702c018420133e2e61fc22ee56757cb8829))
* **import:** the duplicate-detection key stops depending on columns a file may not carry ([#323](https://github.com/NonoHM/budgetpilot/issues/323)) ([e528df2](https://github.com/NonoHM/budgetpilot/commit/e528df2fc0c184bec1b60defd3c359682d529499))
* **import:** the invalid-rows summary offers the way back to the columns ([#345](https://github.com/NonoHM/budgetpilot/issues/345)) ([3ac286e](https://github.com/NonoHM/budgetpilot/commit/3ac286efc2db2db289ea0f926f8b9406ec10cc7a)), closes [#342](https://github.com/NonoHM/budgetpilot/issues/342)
* **import:** the memorised columns are reachable and correctable from /imports ([#347](https://github.com/NonoHM/budgetpilot/issues/347)) ([8e45277](https://github.com/NonoHM/budgetpilot/commit/8e45277b6f1a11fd479c9eaabbd440cf5aa069da))
* **import:** the three components the column-designation screen needs, registered before anything consumes them ([#329](https://github.com/NonoHM/budgetpilot/issues/329)) ([eb1aa79](https://github.com/NonoHM/budgetpilot/commit/eb1aa79317f467b66d4f22ee5da2fb6e0a4b586a))


### Bug Fixes

* **import:** a debit/credit indicator column no longer makes every row income ([#321](https://github.com/NonoHM/budgetpilot/issues/321)) ([ddaf9f0](https://github.com/NonoHM/budgetpilot/commit/ddaf9f0cf4dfd1e259b50a90f88c6bf1e0d53771))
* **import:** a designated import reports its summary, on the run that designated it ([#341](https://github.com/NonoHM/budgetpilot/issues/341)) ([4bd10ec](https://github.com/NonoHM/budgetpilot/commit/4bd10ec17efe83105768b83b9de59791dc82b333)), closes [#338](https://github.com/NonoHM/budgetpilot/issues/338)
* **import:** a file that declares a non euro currency is refused, not relabelled ([#314](https://github.com/NonoHM/budgetpilot/issues/314)) ([d0ec79a](https://github.com/NonoHM/budgetpilot/commit/d0ec79aabfcca08e7a2769262015594c0f216232))
* **import:** a headerless file keeps its first transaction, and the fixture generator becomes tracked ([#365](https://github.com/NonoHM/budgetpilot/issues/365)) ([e53bd1c](https://github.com/NonoHM/budgetpilot/commit/e53bd1cf028e46e7572520f813b6f1f6bc6abf0f))
* **import:** a refusal is a structured fact, and header complaints lose their invented line numbers ([#305](https://github.com/NonoHM/budgetpilot/issues/305)) ([31697a5](https://github.com/NonoHM/budgetpilot/commit/31697a5c0e2aeffe86578472f528fbdb2303731d))
* **import:** refuse a split debit/credit statement at upload, before the screen opens ([#346](https://github.com/NonoHM/budgetpilot/issues/346)) ([ff1613f](https://github.com/NonoHM/budgetpilot/commit/ff1613f471e6627e82106678fe3f2b685e874150)), closes [#343](https://github.com/NonoHM/budgetpilot/issues/343)
* **import:** Revolut reads its English export, and its column order stops mattering ([#310](https://github.com/NonoHM/budgetpilot/issues/310)) ([14f055a](https://github.com/NonoHM/budgetpilot/commit/14f055ac9cf0c018366c7597f5fb523e64f6717b))
* **import:** the column picker's samples are chosen to discriminate, not taken from the top ([#344](https://github.com/NonoHM/budgetpilot/issues/344)) ([d57801d](https://github.com/NonoHM/budgetpilot/commit/d57801d04168f50de52115ea2322c550ce516e20))
* **import:** the date wall on the fourth profile, the columns you can forget, and the row that was being eaten ([#364](https://github.com/NonoHM/budgetpilot/issues/364)) ([062fde3](https://github.com/NonoHM/budgetpilot/commit/062fde3cbcc2861e37b93c0175d72bf88cfbc15b))
* **import:** the designation picker opens at 1280, anchored under the row that opened it ([#336](https://github.com/NonoHM/budgetpilot/issues/336)) ([f48990d](https://github.com/NonoHM/budgetpilot/commit/f48990d6823900a9b8b237a8ec440520ba834099))
* **import:** the duplicate-detection key stops depending on the file's name ([#317](https://github.com/NonoHM/budgetpilot/issues/317)) ([2dc895a](https://github.com/NonoHM/budgetpilot/commit/2dc895a19c5db916d7972fe04f4aa872b930b52d))
* **import:** the four blocking defects on the import path, and the copy that repeated itself ([#355](https://github.com/NonoHM/budgetpilot/issues/355)) ([6592256](https://github.com/NonoHM/budgetpilot/commit/659225652e447eb991de3b4cd923661d8c7a64f5))
* **import:** the page stops claiming five profiles are offered, because none is ([#311](https://github.com/NonoHM/budgetpilot/issues/311)) ([21a85bc](https://github.com/NonoHM/budgetpilot/commit/21a85bc86474419593eb20eb65211734049f0fd6))
* **import:** the rescue reaches the file whose values failed, and the date says what it wants ([#362](https://github.com/NonoHM/budgetpilot/issues/362)) ([d5fe138](https://github.com/NonoHM/budgetpilot/commit/d5fe13868980f18e1494e0af04e70a6ea395bf44))
* **import:** the silent double import, and the two it already made ([#359](https://github.com/NonoHM/budgetpilot/issues/359)) ([88262b5](https://github.com/NonoHM/budgetpilot/commit/88262b59aaad94eca78466e1c071c5a424277153))


### Documentation

* **contributing:** a break patch is undone in a finally, not on the next line ([#361](https://github.com/NonoHM/budgetpilot/issues/361)) ([f47cc30](https://github.com/NonoHM/budgetpilot/commit/f47cc30088cdde62eee5579cc6d283289cd36245))
* **import:** the manual describes designation, and stops promising it in the future tense ([#337](https://github.com/NonoHM/budgetpilot/issues/337)) ([43514f3](https://github.com/NonoHM/budgetpilot/commit/43514f3ef96b780d7b18de3bda9aecfd98fbaa9b))


### Maintenance

* bump distroless/nodejs24-debian13 from `af85d11` to `fbbdda8` ([#295](https://github.com/NonoHM/budgetpilot/issues/295)) ([2ff18f9](https://github.com/NonoHM/budgetpilot/commit/2ff18f96c785ace30930046a34bc101de6cacf84))
* bump the actions-patch-minor group with 2 updates ([#297](https://github.com/NonoHM/budgetpilot/issues/297)) ([e9bf2ef](https://github.com/NonoHM/budgetpilot/commit/e9bf2ef6dcb21aa53ba45ace565757f693ae2b8c))
* bump the npm-lint-tooling group across 1 directory with 2 updates ([#293](https://github.com/NonoHM/budgetpilot/issues/293)) ([c3e7093](https://github.com/NonoHM/budgetpilot/commit/c3e7093cf2c1c079bb0e026b56ddf136b2090ceb))
* bump the npm-patch-minor group with 8 updates ([#296](https://github.com/NonoHM/budgetpilot/issues/296)) ([226d8ff](https://github.com/NonoHM/budgetpilot/commit/226d8ff3da8a4f867a10763de01032aceb54c392))

## [0.11.2](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.11.1...budgetpilot-v0.11.2) (2026-08-13)


### Bug Fixes

* **backup:** bound a restore by its structure, before the parse that costs ([#286](https://github.com/NonoHM/budgetpilot/issues/286)) ([f85b37f](https://github.com/NonoHM/budgetpilot/commit/f85b37f199fc21cef14e86cc5edac55700c8fdad)), closes [#276](https://github.com/NonoHM/budgetpilot/issues/276)
* **import:** bound what an xlsx expands to, not just what it weighs ([#282](https://github.com/NonoHM/budgetpilot/issues/282)) ([bc59cc8](https://github.com/NonoHM/budgetpilot/commit/bc59cc8625f8644c4674324883aea63b94acb9e7))
* **import:** make isValidIsoDate a predicate, and delete the workaround it forced ([#278](https://github.com/NonoHM/budgetpilot/issues/278)) ([c539dae](https://github.com/NonoHM/budgetpilot/commit/c539dae45a000a18fe6df27d6a7d3089cb0c4ccc)), closes [#275](https://github.com/NonoHM/budgetpilot/issues/275)


### Documentation

* **agents:** state what a test has to do, and what a green one does not say ([#279](https://github.com/NonoHM/budgetpilot/issues/279)) ([9a13089](https://github.com/NonoHM/budgetpilot/commit/9a130890ba0bb06dcff3a056ba589316f8ca8c85))
* **configuration:** BODY_SIZE_LIMIT named the wrong limit ([#285](https://github.com/NonoHM/budgetpilot/issues/285)) ([d2ba73d](https://github.com/NonoHM/budgetpilot/commit/d2ba73d008be98734c274b7b9c4c1f9b9a7e4ce6))
* **database:** require TLS on a remote database, and say which parameter ([#256](https://github.com/NonoHM/budgetpilot/issues/256)) ([7689347](https://github.com/NonoHM/budgetpilot/commit/7689347bf3833aac0c47345b3a59dc18b03f5759))
* **operations:** document how to roll back a release, and serialise publishes ([#239](https://github.com/NonoHM/budgetpilot/issues/239)) ([54d9032](https://github.com/NonoHM/budgetpilot/commit/54d9032db81890a84da444d165f82ff2d6e98843))
* **security:** add the Best Practices badge, and say what both badges do not mean ([#243](https://github.com/NonoHM/budgetpilot/issues/243)) ([85d4b6b](https://github.com/NonoHM/budgetpilot/commit/85d4b6bdf39e55d393f7769591ac7b3487f62dc7))
* **security:** publish what was verified, by whom, and what is not covered ([#287](https://github.com/NonoHM/budgetpilot/issues/287)) ([bad452f](https://github.com/NonoHM/budgetpilot/commit/bad452f7bd3be742f0ef8cef62365074f37b0666))
* **security:** state the ASVS 5.0 Level 2 self-assessment, retire the 4.0.3 citations ([#257](https://github.com/NonoHM/budgetpilot/issues/257)) ([4a5d945](https://github.com/NonoHM/budgetpilot/commit/4a5d945b7ce1c5ecb3cbdfff821333105d9b8b56))


### Maintenance

* ignore the security programme's working directory ([#268](https://github.com/NonoHM/budgetpilot/issues/268)) ([20d38d1](https://github.com/NonoHM/budgetpilot/commit/20d38d11b2299691da8acace8d3454fa2031f1ba))

## [0.11.1](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.11.0...budgetpilot-v0.11.1) (2026-08-13)


### Bug Fixes

* **security:** sign 0.11.0's successor, and stop a signing failure losing the SBOM ([#237](https://github.com/NonoHM/budgetpilot/issues/237)) ([ec120f7](https://github.com/NonoHM/budgetpilot/commit/ec120f7da8ecfc3dbfc1c0ec347cd1fd0353560e))

## [0.11.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.10.0...budgetpilot-v0.11.0) (2026-08-13)


### Features

* **security:** sign the published image and the release SBOM ([#218](https://github.com/NonoHM/budgetpilot/issues/218)) ([#235](https://github.com/NonoHM/budgetpilot/issues/235)) ([172f88d](https://github.com/NonoHM/budgetpilot/commit/172f88d9c3bac3000ba04ad961617414db34bc5b))


### Documentation

* **security:** state when a change needs a new penetration-testing pass ([#234](https://github.com/NonoHM/budgetpilot/issues/234)) ([381415f](https://github.com/NonoHM/budgetpilot/commit/381415fbf6f4807924419cd9cfd9e265bc20cf69))

## [0.10.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.9.1...budgetpilot-v0.10.0) (2026-08-12)


### ⚠ BREAKING CHANGES

* reverse-proxy deployments must remove ADDRESS_HEADER and XFF_DEPTH and set TRUSTED_PROXIES to the proxy's IP or CIDR, or the app refuses to start. The bundled Caddy overlay (docker-compose.proxy.yml) is already migrated. See docs/operations.md "Before you upgrade past 0.9.1".

### Bug Fixes

* **insights:** the AI prompt now admits when it shares transaction labels ([#216](https://github.com/NonoHM/budgetpilot/issues/216)) ([#232](https://github.com/NonoHM/budgetpilot/issues/232)) ([d48fd91](https://github.com/NonoHM/budgetpilot/commit/d48fd91d442ce00801cff21ab93b9946e6b04652))
* **security:** re-validate redirect targets against the host allowlist on provider fetches ([#215](https://github.com/NonoHM/budgetpilot/issues/215)) ([#231](https://github.com/NonoHM/budgetpilot/issues/231)) ([6480db8](https://github.com/NonoHM/budgetpilot/commit/6480db8e69aa68af6f75a97694e089efdfdcaba6))
* **settings:** re-authenticate before deleting an account, and localise the phrase ([#220](https://github.com/NonoHM/budgetpilot/issues/220), [#203](https://github.com/NonoHM/budgetpilot/issues/203)) ([#230](https://github.com/NonoHM/budgetpilot/issues/230)) ([aba0bee](https://github.com/NonoHM/budgetpilot/commit/aba0bee9eada86fdcec5f0ebbbe98626c5bf3141))
* validate X-Forwarded-For against a TRUSTED_PROXIES allowlist ([#219](https://github.com/NonoHM/budgetpilot/issues/219)) ([#226](https://github.com/NonoHM/budgetpilot/issues/226)) ([4b6ca13](https://github.com/NonoHM/budgetpilot/commit/4b6ca132ba56b46043a3b8a40eb4c116c3003c75))


### Documentation

* add the OpenSSF Scorecard badge, with what it does and does not measure ([#233](https://github.com/NonoHM/budgetpilot/issues/233)) ([220f65f](https://github.com/NonoHM/budgetpilot/commit/220f65ffe39675c3f4087d576ec46d77e2416b92))

## [0.9.1](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.9.0...budgetpilot-v0.9.1) (2026-08-12)


### Documentation

* record where this project differs, and what it will not do ([#183](https://github.com/NonoHM/budgetpilot/issues/183)) ([9309908](https://github.com/NonoHM/budgetpilot/commit/930990863cd8de437807768ce365c43662572d03))

## [0.9.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.8.1...budgetpilot-v0.9.0) (2026-08-12)


### Features

* **categories:** offer to rename the seeded categories into your own language ([#181](https://github.com/NonoHM/budgetpilot/issues/181)) ([cd15816](https://github.com/NonoHM/budgetpilot/commit/cd158166fb38c39276398b47386d6f7a1a43ff35))
* **db:** clear Category.defaultKey on every install ([#162](https://github.com/NonoHM/budgetpilot/issues/162)) ([#177](https://github.com/NonoHM/budgetpilot/issues/177)) ([b56b095](https://github.com/NonoHM/budgetpilot/commit/b56b095bb69c5d94a515ce4b54fbc805094a7190))


### Documentation

* **categories:** a category has one name, and say so everywhere ([#162](https://github.com/NonoHM/budgetpilot/issues/162)) ([#182](https://github.com/NonoHM/budgetpilot/issues/182)) ([10a0da1](https://github.com/NonoHM/budgetpilot/commit/10a0da1afdace190cb997e8ab2d719df88429d14))

## [0.8.1](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.8.0...budgetpilot-v0.8.1) (2026-08-12)


### Bug Fixes

* **build:** stop hiding operator-facing changes from the changelog ([#178](https://github.com/NonoHM/budgetpilot/issues/178)) ([37c55f6](https://github.com/NonoHM/budgetpilot/commit/37c55f615476ba195ad6ead70aa27bb5b1e46336))
* **categories:** pause rules whose target category was deleted ([#161](https://github.com/NonoHM/budgetpilot/issues/161)) ([#173](https://github.com/NonoHM/budgetpilot/issues/173)) ([ee337e1](https://github.com/NonoHM/budgetpilot/commit/ee337e192aee4c070b3bf06d63f2abee990e3666))
* **i18n:** remove em dashes from the strings users actually read ([#170](https://github.com/NonoHM/budgetpilot/issues/170)) ([546a4ea](https://github.com/NonoHM/budgetpilot/commit/546a4ea572e94e0a26d692f6b92c314f6ac64fa4))


### Behaviour and internals

* **categories:** seeded categories now show their stored French name until you rename them. An English instance that displayed "Groceries" for the category stored as "Alimentation" now displays "Alimentation", because a category's stored name has become its only name and there is no translation layer left. Nothing is renamed, no data moves, and every budget, rule and report keeps pointing where it did. A later release adds a one-click prompt on /categories that renames the seeded categories into the language you read. ([#162](https://github.com/NonoHM/budgetpilot/issues/162)) ([#176](https://github.com/NonoHM/budgetpilot/issues/176)) ([98c281c](https://github.com/NonoHM/budgetpilot/commit/98c281cf0bf9721c1037af1e7a5a50951b5642a7))


### Documentation

* replace em dashes with the punctuation each sentence wants ([#169](https://github.com/NonoHM/budgetpilot/issues/169)) ([4844684](https://github.com/NonoHM/budgetpilot/commit/48446845c01c9ba29057ec4730d885cf098807cc))

## [0.8.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.7.0...budgetpilot-v0.8.0) (2026-08-10)


### Features

* **a11y:** a polite announcer that survives a value changing on every keystroke ([53cb500](https://github.com/NonoHM/budgetpilot/commit/53cb5008a94f36a3da0c7afef674c98f44735d69))
* **budget:** the dashboard boundary emits allocations alongside transactions ([17ab5dc](https://github.com/NonoHM/budgetpilot/commit/17ab5dc8b3238c76927c1798d6d90bcd135ee4de))
* **db:** add TransactionSplit, with backup export and restore ([3f882d1](https://github.com/NonoHM/budgetpilot/commit/3f882d1f24e93a54a3fe74795f9af5d39321e5c9))
* **domain:** add CategoryAllocation and the total allocation read ([c2962c9](https://github.com/NonoHM/budgetpilot/commit/c2962c9e5b2796bf640d5a2207394fa858438139))
* **domain:** add distributeEvenly for the even-split helper ([b89da59](https://github.com/NonoHM/budgetpilot/commit/b89da597e1e21f58d28a836d66e1164ee36770bc))
* **export:** one line per allocation, and the three columns that pay for it ([c7c7b92](https://github.com/NonoHM/budgetpilot/commit/c7c7b921c551c0b58e18775ec2064c3eab06b0c7))
* **import:** a SECOND maison profile, never an edit to the first ([e168c3f](https://github.com/NonoHM/budgetpilot/commit/e168c3f0b92346094f059004a57fb94feaa98de6))
* **import:** imported parts go through replaceSplits, never at the table ([1bfda30](https://github.com/NonoHM/budgetpilot/commit/1bfda30a9c4798e6eead64b2ed4416e47773bc6b))
* **money:** every per-category read goes through allocations, guarded per engine ([a70d7d1](https://github.com/NonoHM/budgetpilot/commit/a70d7d1baf81d5b10de2f447e97892ed4607b62e))
* **sheet:** the way back never scrolls either, in every sheet ([52055f6](https://github.com/NonoHM/budgetpilot/commit/52055f65d6dd4b3fa4e20083c02dd979d634ee68))
* **splits:** a category deleted in another window, at both moments 1r names ([8a081ae](https://github.com/NonoHM/budgetpilot/commit/8a081ae258ae5d9350b505fb7866002cc2db0811))
* **splits:** a répartie transaction leaves every identity-side pile and write ([ab0a3e7](https://github.com/NonoHM/budgetpilot/commit/ab0a3e713b55a163f6b4fdd36ab0c038df9c5155))
* **splits:** a répartition indicator on three parent-shaped surfaces ([323c556](https://github.com/NonoHM/budgetpilot/commit/323c556f319003be39feffe9fe27f9d02be07cff))
* **splits:** filtered totals sum the matching parts, and ?category= reaches them ([8265dd8](https://github.com/NonoHM/budgetpilot/commit/8265dd8bddf23b19f088dfcd75e849fd084a90d6))
* **splits:** focus after add and remove, made a decision rather than a coincidence ([dcabdb7](https://github.com/NonoHM/budgetpilot/commit/dcabdb709215609bad30adbab91ca53c7e2b998b))
* **splits:** the Catégorie column stops describing the parent ([399eb6a](https://github.com/NonoHM/budgetpilot/commit/399eb6a73aa46e334571ae553304451ae1d139cf))
* **splits:** the editor and its write path — one panel, three entrances ([1879f8e](https://github.com/NonoHM/budgetpilot/commit/1879f8e429ff6b2f402c3a3ec4619c34f3fc64fb))
* **splits:** the editor becomes reachable — one door, two mounts, one lock ([d20ee39](https://github.com/NonoHM/budgetpilot/commit/d20ee391583e527bbda135f621a1300e715f4a2f))
* **splits:** the load hands each row its indicator, through the canonical read ([cde97aa](https://github.com/NonoHM/budgetpilot/commit/cde97aa7177e63030790ffb2bfb5d54cda945af2))
* **splits:** the remainder band and its announcement, as one component ([f648109](https://github.com/NonoHM/budgetpilot/commit/f648109b331ad3c3327dbacce578cae5d6b264b0))
* **splits:** the remainder's arithmetic, in the parent's sign rather than the raw one ([5516a03](https://github.com/NonoHM/budgetpilot/commit/5516a0375597abb758c8a9b48fcd0ea1f0f266f5))
* **splits:** the Répartition filter, conditional and counted, on all four surfaces ([62d4151](https://github.com/NonoHM/budgetpilot/commit/62d4151001382a62801a0816642b327a749a44b7))
* **splits:** the repeatable part, two lines and three note states ([e260167](https://github.com/NonoHM/budgetpilot/commit/e260167950f61d3189232d9e442934601493ba05))
* **splits:** the row indicator's rule, and the badge that renders it ([aedfa7f](https://github.com/NonoHM/budgetpilot/commit/aedfa7fa8d6610ce217ed6dd7add6f7280022560))
* **splits:** the saving state, and the remount that has to come with it ([74459c1](https://github.com/NonoHM/budgetpilot/commit/74459c1ce897c15c81e9892fa23bf59d1a02c584))
* **splits:** what the load hands the editor — ids, ordered parts, and a door ([7904d6e](https://github.com/NonoHM/budgetpilot/commit/7904d6e70cf43b6551dd203c52e8bbc1cef8e9d3))
* **transactions:** replaceSplits, the single write path for a repartition ([06e8c57](https://github.com/NonoHM/budgetpilot/commit/06e8c573f6d737149a2febd3de7641cd011f9527))
* **transactions:** split transactions — category allocation, filtered rows, UI conformance ([ce9afb6](https://github.com/NonoHM/budgetpilot/commit/ce9afb653b3c53199470a30e04c662488055d488))
* **ui:** Combobox neutralises without going mute ([3ba3d44](https://github.com/NonoHM/budgetpilot/commit/3ba3d447cc52c9a60358c72ad5c1d18bb09aae2b))
* **ui:** the three shared controls the split editor needs, each as a real prop ([390a30f](https://github.com/NonoHM/budgetpilot/commit/390a30f49ba016a07264a003cc512e9a928e2a86))


### Bug Fixes

* **backup:** a part must carry its parent's sign, on every write path ([9a3abf7](https://github.com/NonoHM/budgetpilot/commit/9a3abf70929e51cead5bd80847785c204d93edc8))
* **backup:** enforce the per-transaction tag cap on restore ([#160](https://github.com/NonoHM/budgetpilot/issues/160)) ([0f27ea2](https://github.com/NonoHM/budgetpilot/commit/0f27ea2448dd46411132f3a99ffcf518c088e2ed))
* **budgets:** fold the category name, and name the month in UTC ([3d8c947](https://github.com/NonoHM/budgetpilot/commit/3d8c9477f074e53d56a5d84608259208b49fca22))
* **budgets:** the folded key is a constraint now, not a docstring ([7486689](https://github.com/NonoHM/budgetpilot/commit/7486689023d4615bb90e694801f16bce65e416fa))
* **categories:** move every stored reference when a category is renamed ([#157](https://github.com/NonoHM/budgetpilot/issues/157)) ([ad320cd](https://github.com/NonoHM/budgetpilot/commit/ad320cd27194f3a4843bcd5f1ff533cbad0753ad))
* **deps:** take nanoid 3.3.18 and SvelteKit 2.70.2, and unblock the release gate ([#163](https://github.com/NonoHM/budgetpilot/issues/163)) ([c3363d3](https://github.com/NonoHM/budgetpilot/commit/c3363d34465a74d0212a15b7569c62cf7bf61638))
* **i18n:** punctuation that differs by locale belongs behind a function ([902a7f7](https://github.com/NonoHM/budgetpilot/commit/902a7f76d42a26d2b8a403e446f76b3f8799ad11))
* **i18n:** punctuation that differs by locale belongs behind a function ([2d5f562](https://github.com/NonoHM/budgetpilot/commit/2d5f562ad910843271722e6c0f46248b85be015a))
* **i18n:** type the locale parameter as string, not the two-locale union ([2d1fc69](https://github.com/NonoHM/budgetpilot/commit/2d1fc69cd08ca12790c42cc5df4dd9aece47cb43))
* **import:** the export's own sentinel, refused by the importer that reads it ([00a3a4f](https://github.com/NonoHM/budgetpilot/commit/00a3a4fe2a40545e385b99b4a5322cf3ea2f7603))
* **reports:** the donut centre through formatCents, like every other figure ([4a937ae](https://github.com/NonoHM/budgetpilot/commit/4a937ae7e2e1d84bb7e083371ade709568fea7ba))
* **rules:** the Category and Nature columns are columns, not transitions ([aed2025](https://github.com/NonoHM/budgetpilot/commit/aed202585d0003c987a6d5d5bbb03559fa65ff63))
* **rules:** the Category and Nature columns are columns, not transitions ([dec503d](https://github.com/NonoHM/budgetpilot/commit/dec503d6144ef864885bd3a534cd6e6dfd524a2f))
* **sheet:** opening a transaction no longer lands on Supprimer ([28e9ae1](https://github.com/NonoHM/budgetpilot/commit/28e9ae1900ab161aa13ca2375109d8a291445241))
* **splits:** a save that fails says so, instead of looking like one that worked ([3d72695](https://github.com/NonoHM/budgetpilot/commit/3d726950d8b8939dae9f5cd11f38abc3d2e8d433))
* **splits:** a SQLite host-parameter cap, and the batching it needed everywhere ([0c97b2b](https://github.com/NonoHM/budgetpilot/commit/0c97b2bb694e7313974622f0b8e25bdc2b95543d))
* **splits:** an unsplit settled occurrence borrows nothing from a later split one ([aa5dd32](https://github.com/NonoHM/budgetpilot/commit/aa5dd32ff0eccae365d1cd55b5f847263e9240b0))
* **splits:** reserve the badge's height on the desktop line, and keep the guard able to see it ([8b3fc2c](https://github.com/NonoHM/budgetpilot/commit/8b3fc2c28f5e731e699380ee935effed7ce8878a))
* **splits:** the dashboard reservation was two pixels short of its own badge ([91ccc56](https://github.com/NonoHM/budgetpilot/commit/91ccc565eb5f021f43dc6faf5e590d011ab2b46c))
* **splits:** the failure sentence belongs to the attempt, and to the row ([8220009](https://github.com/NonoHM/budgetpilot/commit/822000982b0fe14b1d7ea763951795231a4d210e))
* **splits:** the plate measured the column where it meant the content ([ec6b78b](https://github.com/NonoHM/budgetpilot/commit/ec6b78b00f80dca89bb2b736d19403a4c606e79f))
* **splits:** the plate measured the column where it meant the content ([3fafeff](https://github.com/NonoHM/budgetpilot/commit/3fafeff0b6d05d056d2d430899b193faf7c8b084))
* **tests:** a font-dependent pixel figure, and the second failure it manufactured ([243c8c4](https://github.com/NonoHM/budgetpilot/commit/243c8c4e3d9d057b8937f32942533fc6859dae37))
* **tests:** the reconciliation the brand made visible ([d56ca70](https://github.com/NonoHM/budgetpilot/commit/d56ca70b81f33baa736eec1bb1da583518c63e36))
* **transactions:** "is this a fragment" compares magnitudes, not signs it does not own ([c5869be](https://github.com/NonoHM/budgetpilot/commit/c5869be7c066314abf0c4912cb5aa23d67c7edd8))
* **transactions:** a category filter shows the matched part, not the dominant one ([ce1f8c2](https://github.com/NonoHM/budgetpilot/commit/ce1f8c2737891e9df2f9a079715043eb80a8475e))
* **transactions:** a row matched by identity alone shows zero, not the dominant part ([6f9a165](https://github.com/NonoHM/budgetpilot/commit/6f9a16506f62cf7bd0ce30787789d9f330902b8c))
* **transactions:** sign an imported expense by its direction, not by its column ([7e1b135](https://github.com/NonoHM/budgetpilot/commit/7e1b135ba8aeb51bbe1307c379c02f2d68c4225b))


### Performance Improvements

* **transactions:** the category filter's part branch gets a covering index ([26852b0](https://github.com/NonoHM/budgetpilot/commit/26852b0d4287299d341b72312ea278fe8b48a7e1))

## [0.7.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.6.0...budgetpilot-v0.7.0) (2026-08-04)


### Features

* **transactions:** a range calendar for Période, and the 390 conformance pass ([#117](https://github.com/NonoHM/budgetpilot/issues/117)) ([373dd99](https://github.com/NonoHM/budgetpilot/commit/373dd99dfb2b9d35d62b40709445a40d88904cf6))

## [0.6.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.5.0...budgetpilot-v0.6.0) (2026-08-03)


### Features

* **i18n:** fall back to English instead of French ([#107](https://github.com/NonoHM/budgetpilot/issues/107)) ([8af0c95](https://github.com/NonoHM/budgetpilot/commit/8af0c95d66d88e1a4a69199a089e82b1d9a57afb))
* **tags:** transverse tags on transactions ([#103](https://github.com/NonoHM/budgetpilot/issues/103)) ([eba7e77](https://github.com/NonoHM/budgetpilot/commit/eba7e7769bcf919cfd5d17c900c88af292cb5f75))
* **transactions:** Période, a filter dimension for a composite value ([#112](https://github.com/NonoHM/budgetpilot/issues/112)) ([0e724e9](https://github.com/NonoHM/budgetpilot/commit/0e724e9431bf561bf83284ec2c992d0b69040ed8))
* **transactions:** tags discoverability and the filter bar ([#108](https://github.com/NonoHM/budgetpilot/issues/108)) ([f90943c](https://github.com/NonoHM/budgetpilot/commit/f90943cad21c26b2e023ca7b2d0adf3df0848e34))


### Bug Fixes

* **register:** say the token is wrong instead of claiming registration is closed ([#105](https://github.com/NonoHM/budgetpilot/issues/105)) ([bf2db59](https://github.com/NonoHM/budgetpilot/commit/bf2db5937561cb51d5162de49c9dd712e92383ce))
* **register:** throttle BOOTSTRAP_TOKEN guessing ([#106](https://github.com/NonoHM/budgetpilot/issues/106)) ([49dffd8](https://github.com/NonoHM/budgetpilot/commit/49dffd82bb36ba3e9d9041106a1a171d20b64997))
* **transactions:** column pinning, search field placement, and the summary band ([#109](https://github.com/NonoHM/budgetpilot/issues/109)) ([dafe765](https://github.com/NonoHM/budgetpilot/commit/dafe76571a3663295648014b7f80ed052f2cb6b3))
* **transactions:** filter triggers at the referential 34px desktop height ([#111](https://github.com/NonoHM/budgetpilot/issues/111)) ([f04734a](https://github.com/NonoHM/budgetpilot/commit/f04734ac766f21f28208889edd8ed3594cf4c9aa))
* **transactions:** one height for the filter bar, and a panel that stays in its box ([#114](https://github.com/NonoHM/budgetpilot/issues/114)) ([627eb8b](https://github.com/NonoHM/budgetpilot/commit/627eb8b15f29594b06d624d2739030faa5904ceb))

## [0.5.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.4.0...budgetpilot-v0.5.0) (2026-08-01)


### Features

* **upcoming-bills:** badge transfer/investment streams instead of hiding them ([#100](https://github.com/NonoHM/budgetpilot/issues/100)) ([0978e84](https://github.com/NonoHM/budgetpilot/commit/0978e8405d339832a971d3690158e0066dd55b97))
* **upcoming-bills:** échéances à venir, widget and /upcoming-bills page ([#95](https://github.com/NonoHM/budgetpilot/issues/95)) ([995d1bb](https://github.com/NonoHM/budgetpilot/commit/995d1bbfb65c6862ff1d1b5e4899c38eb51e202f))


### Bug Fixes

* **forecast:** pin the detector's upper bound and apply the staleness guard to the cash-flow forecast ([#97](https://github.com/NonoHM/budgetpilot/issues/97)) ([cfab7a8](https://github.com/NonoHM/budgetpilot/commit/cfab7a80cb723b10ff7d907155c964691ad16893))
* **upcoming-bills:** stop counting stale streams as streams you have ([#99](https://github.com/NonoHM/budgetpilot/issues/99)) ([b536e81](https://github.com/NonoHM/budgetpilot/commit/b536e81c1011fced8b56360df28870162c257f5a))

## [0.4.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.3.1...budgetpilot-v0.4.0) (2026-07-31)


### ⚠ BREAKING CHANGES

* **docker:** the container runs as uid 65532 instead of the old image's system uid. A SQLite install's existing /data volume is owned by the old uid, and the new container cannot write to it. boot.mjs checks this before Prisma is ever reached and refuses to start with the exact remediation (`docker run --rm -v <volume>:/data busybox chown -R 65532:65532 /data`), rather than letting the first symptom be SQLITE_CANTOPEN. The fix runs in a helper image because this one has no chown — that is the base, not an oversight. PostgreSQL and MySQL installs are unaffected. See docs/operations.md, which also documents what replaces `docker compose exec budgetpilot sh`.

### Features

* **ci:** CVE gate at publish, daily scan of the published image, and per-release SBOM ([#89](https://github.com/NonoHM/budgetpilot/issues/89)) ([b71b95a](https://github.com/NonoHM/budgetpilot/commit/b71b95ac6f3c747c4d4a6f8c5cfde396f754c807))
* **docker:** distroless runtime image ([#85](https://github.com/NonoHM/budgetpilot/issues/85)) ([29ac8db](https://github.com/NonoHM/budgetpilot/commit/29ac8dbe3f70ad268f7ffa3542cfce9e843b956d))
* **docker:** read-only, cap-dropped, no-new-privileges runtime posture ([#86](https://github.com/NonoHM/budgetpilot/issues/86)) ([3bd5d16](https://github.com/NonoHM/budgetpilot/commit/3bd5d162177bfe495bdda8fea243214faba7075c))


### Bug Fixes

* **ci:** bound every job, and stop the Playwright install hanging on apt ([#87](https://github.com/NonoHM/budgetpilot/issues/87)) ([157ca71](https://github.com/NonoHM/budgetpilot/commit/157ca71a167bef937c7749d7adca81a377d508cb))
* **docker:** replace the shell entrypoint with a shell-free boot.mjs ([#83](https://github.com/NonoHM/budgetpilot/issues/83)) ([18f0e16](https://github.com/NonoHM/budgetpilot/commit/18f0e16f44030304683d778870e26c67d23f994e))
* **ops:** pin ollama/ollama to a fixed tag ([#81](https://github.com/NonoHM/budgetpilot/issues/81)) ([cdc7942](https://github.com/NonoHM/budgetpilot/commit/cdc7942f462f3919a6acb5c41b5f0f420db182d0))

## [0.3.1](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.3.0...budgetpilot-v0.3.1) (2026-07-31)


### Bug Fixes

* **ops:** make the documented upgrade preview work, serialize boot backfills, split the AI overlay ([#76](https://github.com/NonoHM/budgetpilot/issues/76)) ([d95a8e7](https://github.com/NonoHM/budgetpilot/commit/d95a8e7496120db8aab6c4a214cc44f45ea52196))

## [0.3.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.2.2...budgetpilot-v0.3.0) (2026-07-30)


### ⚠ BREAKING CHANGES

* **db:** category names differing only in case or accents are now one category everywhere, and rows that fold together are merged once at startup. "Courses" and "courses" were two categories and are now one; a budget on "Courses" now counts transactions pinned to "courses", where it silently ignored them before. Import buckets pointing at different bank connections or provider accounts are not merged, and net worth accounts are never merged; both are reported instead. Preview it on your own data with `npm run db:normalize-names -- --dry-run`. See docs/operations.md.

### Features

* **db:** compare import deduplication keys on an app-computed hash ([#68](https://github.com/NonoHM/budgetpilot/issues/68)) ([557dd82](https://github.com/NonoHM/budgetpilot/commit/557dd82a5537e0be0e7ac1098f839da12dbb4ad4))
* **db:** compare names on an app-computed key instead of the database collation ([#66](https://github.com/NonoHM/budgetpilot/issues/66)) ([4b407af](https://github.com/NonoHM/budgetpilot/commit/4b407af5f15e8cdd413433376f36c6634360792a))
* **db:** enforce name and fingerprint uniqueness on the app-computed keys ([#70](https://github.com/NonoHM/budgetpilot/issues/70)) ([96d82fc](https://github.com/NonoHM/budgetpilot/commit/96d82fc967a270193c0f9acb7fb629d1f91be022))
* **db:** generate a Prisma schema and a migration history per provider ([#69](https://github.com/NonoHM/budgetpilot/issues/69)) ([adbcc95](https://github.com/NonoHM/budgetpilot/commit/adbcc950318085544dfe9bd50799c1bcd6abbd33))
* **db:** generate every provider's Prisma client at build time, and prove all three ship ([#74](https://github.com/NonoHM/budgetpilot/issues/74)) ([34557e1](https://github.com/NonoHM/budgetpilot/commit/34557e17df6d58ad0c153eb8d300a74b7156f948))
* **db:** PostgreSQL and MySQL Compose overlays, and the docs for switching ([#75](https://github.com/NonoHM/budgetpilot/issues/75)) ([492431c](https://github.com/NonoHM/budgetpilot/commit/492431cf8fa0e3cf07863ffbb115799e1a53f887))
* **db:** run the full CI matrix on PostgreSQL and MySQL, and fix what it found ([#71](https://github.com/NonoHM/budgetpilot/issues/71)) ([3c0f414](https://github.com/NonoHM/budgetpilot/commit/3c0f41436d5bf7551076a73316a06bc355d859a4))
* **db:** size every column for MySQL and stop the collation deciding email identity ([#73](https://github.com/NonoHM/budgetpilot/issues/73)) ([68a9f83](https://github.com/NonoHM/budgetpilot/commit/68a9f839d57563ed5791db43ff0081b2429685f4))

## [0.2.2](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.2.1...budgetpilot-v0.2.2) (2026-07-29)


### Bug Fixes

* **csp:** stop every page reporting a blocked inline style ([#57](https://github.com/NonoHM/budgetpilot/issues/57)) ([66af241](https://github.com/NonoHM/budgetpilot/commit/66af241ccc0c7a718f81e734e4febb378bbc951e))
* **dashboard:** stream the AI advice instead of blocking the page on it ([#59](https://github.com/NonoHM/budgetpilot/issues/59)) ([d5567e8](https://github.com/NonoHM/budgetpilot/commit/d5567e8c6a760ead2ef6b5392736ee4d4c168928))
* **deps:** pin @types/node ignore rule to the actual Node runtime major ([#50](https://github.com/NonoHM/budgetpilot/issues/50)) ([90853b3](https://github.com/NonoHM/budgetpilot/commit/90853b396ee24435a5698452877b3f8bbf686844))
* **insights:** send the model euros, not raw cents, and reply in the user's language ([#55](https://github.com/NonoHM/budgetpilot/issues/55)) ([0db980d](https://github.com/NonoHM/budgetpilot/commit/0db980d6f4250d722a407fa61f7097602a413924))
* **proxy:** actually unpublish the app port behind the Caddy overlay ([#54](https://github.com/NonoHM/budgetpilot/issues/54)) ([337aa92](https://github.com/NonoHM/budgetpilot/commit/337aa9235e7350a5254d2dfa2101c02eef946bb7))

## [0.2.1](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.2.0...budgetpilot-v0.2.1) (2026-07-28)


### Bug Fixes

* **self-hosting:** make PUBLIC_INSTANCE the sole, fail-secure Secure-cookie switch ([#46](https://github.com/NonoHM/budgetpilot/issues/46)) ([123cf72](https://github.com/NonoHM/budgetpilot/commit/123cf7284ba85dc1047a46925ce3a9c3f3650d0e))

## [0.2.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.1.2...budgetpilot-v0.2.0) (2026-07-28)


### Features

* **setup:** re-land interactive setup script lost in the history rewrite ([#28](https://github.com/NonoHM/budgetpilot/issues/28)) ([6211d02](https://github.com/NonoHM/budgetpilot/commit/6211d024d2f5e835c2a55b845a788c9c41844d92))


### Bug Fixes

* **docker:** make ORIGIN configurable, close Docker install friction points ([#23](https://github.com/NonoHM/budgetpilot/issues/23)) ([6c6d5ed](https://github.com/NonoHM/budgetpilot/commit/6c6d5ed62c78021d0d6022d698b2c2bfef846e86))
* ship NODE_ENV=development and unstrand the CHANGELOG preamble ([#31](https://github.com/NonoHM/budgetpilot/issues/31)) ([80f3e03](https://github.com/NonoHM/budgetpilot/commit/80f3e038b455ce23fda13ce6f2d4802fdb2ddc92))
* **test:** target the logout button directly instead of page-level keyboard ([#29](https://github.com/NonoHM/budgetpilot/issues/29)) ([de08ec7](https://github.com/NonoHM/budgetpilot/commit/de08ec72fb6daed5b212d23a7c656eaf091281de))

## [0.1.2](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.1.1...budgetpilot-v0.1.2) (2026-07-27)


### Bug Fixes

* don't force-checkout the release tag on docker-publish workflow_dispatch ([4f40b54](https://github.com/NonoHM/budgetpilot/commit/4f40b54abc0d1a34e23763fdbe74313fcae95f93))
* set build-time-only env placeholders in Dockerfile builder stage ([1400c7a](https://github.com/NonoHM/budgetpilot/commit/1400c7a37b40e8c46e973284ffe66266e88968d4))

## [0.1.1](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.1.0...budgetpilot-v0.1.1) (2026-07-27)


### Bug Fixes

* correct previous commit — CI unit test failures were a locale bug, not a flake ([3c12baf](https://github.com/NonoHM/budgetpilot/commit/3c12baf91498bc9e454d0eb9b47ae6aad7f39715))
* exclude CHANGELOG.md from Prettier checks ([921d97a](https://github.com/NonoHM/budgetpilot/commit/921d97a3b2c1adbdb0faebfe57c0afe1451895bd))
* scope Playwright e2e to Chromium only ([7de37c6](https://github.com/NonoHM/budgetpilot/commit/7de37c6681d586778c389e88ad5f5a0d021f5a33))
