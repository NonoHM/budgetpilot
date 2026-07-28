# Changelog

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
