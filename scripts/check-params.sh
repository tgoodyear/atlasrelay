#!/usr/bin/env bash
# Fails when a value shared by infra/main.bicepparam and infra/app.bicepparam differs.
# Both files deploy app.bicep (bootstrap vs CI); drift would make one path undo the other.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
export GITHUB_OIDC_SUBJECT_PREFIX="${GITHUB_OIDC_SUBJECT_PREFIX:-repo:placeholder@0/placeholder@0}"
export BUDGET_START_DATE="${BUDGET_START_DATE:-2000-01-01}"
export BUDGET_CONTACT_EMAIL="${BUDGET_CONTACT_EMAIL:-nobody@example.invalid}"
main="$(az bicep build-params --file "$here/infra/main.bicepparam" --stdout | jq -c '.parametersJson | fromjson | .parameters')"
app="$(az bicep build-params --file "$here/infra/app.bicepparam" --stdout | jq -c '.parametersJson | fromjson | .parameters')"
status=0
for key in baseName swaLocation swaSku stagingEnvironmentPolicy enableApplicationInsights storageKeyIndex additionalAppSettings; do
  a="$(jq -c --arg k "$key" '.[$k].value' <<<"$main")"
  b="$(jq -c --arg k "$key" '.[$k].value' <<<"$app")"
  if [[ "$a" != "$b" ]]; then
    echo "param drift: $key main.bicepparam=$a app.bicepparam=$b" >&2
    status=1
  fi
done
[[ $status -eq 0 ]] && echo "shared parameters match"
exit $status
