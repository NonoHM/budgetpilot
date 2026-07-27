# Changelog

## [0.2.0](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.1.2...budgetpilot-v0.2.0) (2026-07-27)


### Features

* **setup:** re-land interactive setup script lost in the history rewrite ([#28](https://github.com/NonoHM/budgetpilot/issues/28)) ([665d112](https://github.com/NonoHM/budgetpilot/commit/665d1121b7a811fdc4d55666beeccc5d5cc9e3d9))


### Bug Fixes

* **docker:** make ORIGIN configurable, close Docker install friction points ([#23](https://github.com/NonoHM/budgetpilot/issues/23)) ([30bebff](https://github.com/NonoHM/budgetpilot/commit/30bebffd6c52f61975a86d0534bc0acf0cbcbf6f))
* ship NODE_ENV=development and unstrand the CHANGELOG preamble ([#31](https://github.com/NonoHM/budgetpilot/issues/31)) ([0f63aa0](https://github.com/NonoHM/budgetpilot/commit/0f63aa0f5d122d7b516a528ddd843620fbffec00))
* **test:** target the logout button directly instead of page-level keyboard ([#29](https://github.com/NonoHM/budgetpilot/issues/29)) ([af9fcd2](https://github.com/NonoHM/budgetpilot/commit/af9fcd2c14e95f87f33087a7257b8c52c3750d0a))

## [0.1.2](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.1.1...budgetpilot-v0.1.2) (2026-07-27)


### Bug Fixes

* don't force-checkout the release tag on docker-publish workflow_dispatch ([4f40b54](https://github.com/NonoHM/budgetpilot/commit/4f40b54abc0d1a34e23763fdbe74313fcae95f93))
* set build-time-only env placeholders in Dockerfile builder stage ([1400c7a](https://github.com/NonoHM/budgetpilot/commit/1400c7a37b40e8c46e973284ffe66266e88968d4))

## [0.1.1](https://github.com/NonoHM/budgetpilot/compare/budgetpilot-v0.1.0...budgetpilot-v0.1.1) (2026-07-27)


### Bug Fixes

* correct previous commit — CI unit test failures were a locale bug, not a flake ([3c12baf](https://github.com/NonoHM/budgetpilot/commit/3c12baf91498bc9e454d0eb9b47ae6aad7f39715))
* exclude CHANGELOG.md from Prettier checks ([921d97a](https://github.com/NonoHM/budgetpilot/commit/921d97a3b2c1adbdb0faebfe57c0afe1451895bd))
* scope Playwright e2e to Chromium only ([7de37c6](https://github.com/NonoHM/budgetpilot/commit/7de37c6681d586778c389e88ad5f5a0d021f5a33))
