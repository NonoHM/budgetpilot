#!/usr/bin/env bash
# Renders a Trivy JSON scan as the short Markdown a human acts on.
#
# WHY THIS EXISTS, since "just print the table" is the obvious alternative and was what we had:
# Trivy's `format: table` prints one row per scanned TARGET, including every target with zero
# findings. Measured on the published image at CRITICAL/HIGH: **651 lines of table for 2
# findings**: three hundred `... | node-pkg | 0` rows around the three that matter. That output
# was going straight into the body of the cve-alert issue, and an alert nobody reads has stopped
# being an alert.
#
# Trivy's table renderer has no switch to suppress clean targets, so the choice was a Go template
# or a filter over JSON. This filters JSON with jq: a template would have to re-implement the
# severity ordering and the empty-input case in Go template syntax, and the JSON is the same data
# the SARIF upload carries, so there is one shape to reason about rather than two.
#
# COMPLETENESS LIVES ELSEWHERE, DELIBERATELY. The SARIF upload keeps carrying the full inventory
# (every severity, unfixed included) to the Security tab, which filters natively and is built for
# it. This script is the human-facing summary and is allowed to be partial. Do not "fix" it by
# adding the clean targets back.
#
# Usage:  scripts/trivy-report.sh <trivy-json-file> [heading]
# Writes Markdown to stdout. Exits 0 whether or not there are findings. The CALLER decides what a
# finding means; this only renders. That separation is why the gate steps keep their own
# `exit-code: 1` rather than reading this script's status.

set -euo pipefail

REPORT="${1:?usage: trivy-report.sh <trivy-json-file> [heading]}"
HEADING="${2:-}"

[ -n "$HEADING" ] && printf '### %s\n\n' "$HEADING"

if [ ! -s "$REPORT" ]; then
	echo "_No report file was produced. This is likely scanner infrastructure (DB mirror,"
	echo "registry) rather than a confirmed finding. Check the run log._"
	exit 0
fi

# `// []` on every optional field: a Result with no Vulnerabilities key at all is the normal shape
# for a clean target, and jq would otherwise emit `null` into the table.
#
# `cell` escapes before interpolating, and that is load-bearing rather than tidy. Package names,
# versions and advisory ids come from THIRD-PARTY IMAGE METADATA, not from us. The output this
# replaced fenced the whole report in four backticks precisely because that text can contain
# backticks; a Markdown TABLE has no fence, so a `|` would split a row into extra columns and a
# backtick would unbalance the code span around it. Neither executes anything (the body is
# Markdown in a GitHub issue), but either makes the row unreadable, which is the exact failure
# this script exists to remove. Newlines collapse for the same reason: one would end the row.
jq -r '
  def cell: tostring | gsub("\\|"; "\\|") | gsub("`"; "'"'"'") | gsub("[\r\n]+"; " ");
  def urlcell: cell | gsub("\\("; "%28") | gsub("\\)"; "%29") | gsub(" "; "%20");
  [ .Results[]? | . as $r | ($r.Vulnerabilities // [])[] | {
      target: $r.Target,
      id: .VulnerabilityID,
      pkg: .PkgName,
      installed: .InstalledVersion,
      fixed: (.FixedVersion // ""),
      sev: .Severity,
      url: (.PrimaryURL // "")
    } ]
  | sort_by({CRITICAL:0, HIGH:1, MEDIUM:2, LOW:3, UNKNOWN:4}[.sev] // 9, .pkg)
  | if length == 0 then
      "No findings at the scanned severities."
    else
      "**\(length) finding\(if length == 1 then "" else "s" end).**\n\n"
      + "| Severity | Package | Installed | Fixed in | Advisory |\n"
      + "| --- | --- | --- | --- | --- |\n"
      + ( map("| \(.sev|cell) | `\(.pkg|cell)` | `\(.installed|cell)` | "
              + (if .fixed == "" then "_no fix published_" else "`\(.fixed|cell)`" end)
              + " | "
              + (if .url == "" then (.id|cell) else "[\(.id|cell)](\(.url|urlcell))" end)
              + " |")
          | join("\n") )
    end
' "$REPORT"
