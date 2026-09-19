#!/usr/bin/env bash
# Guards the parameter files the two deployment paths share.
# 1. Fails when a value shared by infra/main.bicepparam and infra/app.bicepparam differs.
#    Both files deploy app.bicep (bootstrap vs CI); drift would make one path undo the other.
# 2. Fails when infra/app.bicepparam binds a custom domain. That file is deployed by the
#    Infrastructure workflow on every merge touching infra/**, so a hostname set there puts the
#    live site's domain binding, and the certificate it carries, on the path of ordinary infra
#    changes. Production hostnames are bound once by hand (scripts/bind-custom-domain.sh).
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
# Only app.bicepparam is checked. infra/dev.bicepparam is where a binding belongs, and it is not
# compared above because dev deliberately differs from production in every value it sets.
appDomain="$(jq -r '.customDomain.value // ""' <<<"$app")"
if [[ -n "$appDomain" ]]; then
  echo "app.bicepparam binds customDomain=$appDomain" >&2
  echo "  production hostnames are bound by scripts/bind-custom-domain.sh, not by CI; see docs/RUNBOOK.md" >&2
  status=1
fi
[[ $status -eq 0 ]] && echo "shared parameters match, app.bicepparam binds no custom domain"
exit $status
