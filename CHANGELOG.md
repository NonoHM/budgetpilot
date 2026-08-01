# Changelog

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
