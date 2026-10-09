#!/usr/bin/env bash
# Pulls one Docker Official Image BY DIGEST from an ordered list of registries, stops at the first
# that serves it, checks the digest the daemon recorded, tags it locally as <name>:<tag>, and says
# which registry served it (#980).
#
#   pull-pinned.sh <name> <tag> <digest>
#
# PULL_PINNED_SOURCES overrides the registries, one prefix per line; `<prefix>/<name>@<digest>` is
# what gets pulled. Default order: mirror.gcr.io (Google's Docker Hub cache), then ECR Public
# (AWS's own copy of the official images, so one mirror's outage or cache miss does not land on
# Docker Hub), then Docker Hub itself as the last resort. All three serve the same digest, so the
# bytes do not depend on which one answers.
#
# There is deliberately no way to pull by tag. A digest no source knows fails here, in this
# script's words, instead of falling back to whatever the tag points at today.
set -euo pipefail

if [ "$#" -ne 3 ]; then
	echo "usage: $0 <name> <tag> <digest>" >&2
	exit 2
fi
name=$1 tag=$2 digest=$3
sources=${PULL_PINNED_SOURCES:-$'mirror.gcr.io/library\npublic.ecr.aws/docker/library\ndocker.io/library'}

# Closed formats, so no argument can steer the pull somewhere else.
if ! [[ "$name" =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]]; then
	echo "::error title=pull-pinned::'$name' is not a bare image name (no registry, namespace or tag)."
	exit 1
fi
if ! [[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
	echo "::error title=pull-pinned::'$tag' is not a valid tag."
	exit 1
fi
if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
	echo "::error title=pull-pinned::'$digest' is not a digest of the form sha256:<64 hex>."
	exit 1
fi

served=''
reasons=''
while IFS= read -r source; do
	source=${source//[[:space:]]/}
	[ -n "$source" ] || continue
	candidate="$source/$name@$digest"
	echo "Trying $candidate"
	if output=$(docker pull --quiet "$candidate" 2>&1); then
		served=$source
		break
	fi
	reason=$(printf '%s\n' "$output" | tail -n 1)
	echo "  not served: $reason"
	reasons+="$source: $reason"$'\n'
done <<< "$sources"

if [ -z "$served" ]; then
	echo "::error title=pull-pinned::No source served $name@$digest ($name:$tag). The image could not be FETCHED, so nothing in the change has run yet. Per source:"
	printf '%s' "$reasons"
	if grep -q 'toomanyrequests' <<< "$reasons"; then
		echo "::error title=pull-pinned::Docker Hub refused the pull with its rate limit (toomanyrequests), after every mirror before it had failed. Re-run once the limit resets; the change is not implicated."
	fi
	if grep -qi 'manifest unknown' <<< "$reasons"; then
		echo "::error title=pull-pinned::A source answered that it does not know this digest. When every source says so, the pin is wrong or was deleted upstream: refresh it as .github/actions/pull-pinned/images.txt says."
	fi
	exit 1
fi

pulled="$served/$name@$digest"
# `docker pull <name>@<digest>` already checks the content against the digest. Asserted again on
# what the daemon RECORDED, so a source that answered with other bytes cannot pass.
repo_digests=$(docker image inspect --format '{{json .RepoDigests}}' "$pulled")
if ! jq -e --arg d "$digest" 'any(.[]; endswith("@" + $d))' <<< "$repo_digests" > /dev/null; then
	echo "::error title=pull-pinned::$served answered, but the image it gave does not carry $digest (RepoDigests: $repo_digests)."
	exit 1
fi

docker tag "$pulled" "$name:$tag"
echo "$name:$tag = $name@$digest, served by $served"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	echo "- \`$name:$tag\` pinned to \`$digest\`, served by **$served**" >> "$GITHUB_STEP_SUMMARY"
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then
	echo "ref=$name:$tag" >> "$GITHUB_OUTPUT"
	echo "source=$served" >> "$GITHUB_OUTPUT"
fi
