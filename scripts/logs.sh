#!/usr/bin/env bash
# Run a saved query (ops/queries/<name>.kql) against the Log Analytics workspace that holds the
# site's Application Insights data, and print the result as a table.
#
#   scripts/logs.sh api-errors          # the last day
#   scripts/logs.sh transfers 7d        # 30m, 6h, 2d or ISO 8601 (PT6H)
#   scripts/logs.sh traffic 7d          # page loads, pages, referrers, campaigns, countries
#   scripts/logs.sh list                # the saved queries
#
# Needs az signed in with an account that can read the workspace, and jq. Uses SUBSCRIPTION_ID if
# set, otherwise az's current subscription; RESOURCE_GROUP and WORKSPACE override the defaults.
set -euo pipefail
[ $# -ge 1 ] && [ $# -le 2 ] || { sed -n '2,11s/^# \{0,1\}//p' "$0" >&2; exit 2; }
NAME=$1
SPAN=${2:-1d}
RESOURCE_GROUP=${RESOURCE_GROUP:-internetresearch}
WORKSPACE=${WORKSPACE:-log-internetresearch}
die() { echo "error: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."

if [ "$NAME" = list ]; then
  for f in ops/queries/*.kql; do
    printf '%-20s %s\n' "$(basename "$f" .kql)" "$(sed -n '1s#^// *##p' "$f")"
  done
  exit 0
fi
[[ $NAME =~ ^[a-z0-9-]+$ ]] && [ -f "ops/queries/$NAME.kql" ] ||
  die "no saved query \"$NAME\"; see: scripts/logs.sh list"
command -v jq > /dev/null || die "jq is needed to build the request and print the result"

# 30m / 6h / 2d → ISO 8601; anything starting with P passes through.
case $SPAN in
  P*) ;;
  *[0-9]m) SPAN="PT${SPAN%m}M" ;;
  *[0-9]h) SPAN="PT${SPAN%h}H" ;;
  *[0-9]d) SPAN="P${SPAN%d}D" ;;
  *) die "timespan \"$SPAN\": use 30m, 6h, 2d or ISO 8601 (PT6H)" ;;
esac
[[ $SPAN =~ ^P([0-9]+D)?(T([0-9]+H)?([0-9]+M)?)?$ ]] && [ "$SPAN" != P ] && [ "$SPAN" != PT ] ||
  die "timespan \"$SPAN\" isn't an ISO 8601 duration"

sub=()
[ -n "${SUBSCRIPTION_ID:-}" ] && sub=(--subscription "$SUBSCRIPTION_ID")
# The query API wants the workspace's customer id (a GUID), not its resource id.
workspace=$(az monitor log-analytics workspace show ${sub[@]+"${sub[@]}"} -g "$RESOURCE_GROUP" -n "$WORKSPACE" \
  --query customerId -o tsv) || die "cannot read workspace $WORKSPACE in $RESOURCE_GROUP (is az signed in?)"

# az rest rather than az monitor log-analytics query, which fails on some az installs.
body=$(mktemp)
trap 'rm -f "$body"' EXIT
jq -n --rawfile q "ops/queries/$NAME.kql" --arg t "$SPAN" '{query: $q, timespan: $t}' > "$body"
if ! result=$(az rest --method post \
  --resource https://api.loganalytics.io \
  --url "https://api.loganalytics.io/v1/workspaces/$workspace/query" \
  --headers Content-Type=application/json \
  --body "@$body" -o json 2>&1); then
  # Workspace-based App Insights defines its App* tables up front, so this only happens against a
  # workspace that was never connected to App Insights.
  if grep -q "Failed to resolve table" <<< "$result"; then
    echo "no data of this kind has reached the workspace yet" >&2
    exit 0
  fi
  echo "$result" >&2
  die "the query failed"
fi

# One tab-separated line per row, header first; tabs and newlines inside values become spaces,
# and empty values "-" (column merges empty fields).
jq -r '.tables[0] as $t
  | ($t.columns | map(.name)), ($t.rows[] | map(if . == null then "" else tostring end))
  | map(gsub("[\t\r\n]+"; " ") | if . == "" then "-" else . end) | @tsv' <<< "$result" |
  column -t -s "$(printf '\t')"
rows=$(jq '.tables[0].rows | length' <<< "$result")
echo "($rows rows, $SPAN)" >&2
