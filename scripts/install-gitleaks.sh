#!/usr/bin/env bash
# Installs the ONE pinned gitleaks release for CI, refusing it unless its SHA-256 matches, then
# proves it detects a planted token before anything trusts a clean result from it.
#
# Used by .github/workflows/private-references-pr.yml and published-text-scan.yml, so the pin lives
# in one place. The hash is the release asset's own, read from the release's checksums file and
# the GitHub asset digest, which agreed when it was pinned. Bumping the version means bumping both
# lines together.
#
# Usage: scripts/install-gitleaks.sh <directory to install into>; prints nothing on success but
# the version and the calibration line.
set -euo pipefail

VERSION=8.30.1
SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb

dest=${1:?usage: install-gitleaks.sh <directory>}
mkdir -p "$dest"
tarball="$dest/gitleaks.tar.gz"
curl -sSfL --retry 3 -o "$tarball" \
	"https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_linux_x64.tar.gz"
echo "${SHA256}  ${tarball}" | sha256sum --check --strict --quiet
tar -xzf "$tarball" -C "$dest" gitleaks
rm -f "$tarball"
"$dest/gitleaks" version

# The calibration lives in the node script beside the hooks, so CI and the hooks plant the same
# token through the same function.
PATH="$dest:$PATH" node "$(dirname "$0")/private-references-git.mjs" calibrate-gitleaks
echo "gitleaks ${VERSION}: checksum verified, planted token detected"
