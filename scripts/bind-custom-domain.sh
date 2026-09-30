#!/usr/bin/env bash
# Bind an environment's hostnames to its static web app, once the domain resolves through the
# zone. Safe to re-run.
#
#   scripts/bind-custom-domain.sh <env> [--apex-only]
#
# prod binds the apex and www. www uses cname-delegation, validated against the www CNAME the
# stack declares (infra/dns.bicep). The apex uses dns-txt-token: the service issues a token that
# has to be published as a TXT record at the apex before the hostname validates. This script
# saves the token as the setting ATLASRELAY_SWA_APEX_TOKEN and redeploys the stack, which
# publishes it, so the stack stays the only writer of the zone. Routing is separate from
# validation: infra/dns.bicep declares the apex A record from the site's stable inbound address,
# because DNS forbids a CNAME at the apex and an Azure alias record cannot target a static site.
#
# --apex-only binds the apex and nothing else. docs/RUNBOOK.md uses it to validate the apex on a
# new site while the domain still routes to an old one. When the stack does not manage the zone
# yet (no ATLASRELAY_DNS_ZONE; pass ZONE_NAME=<domain>), the token is saved and the command that
# publishes it by hand is printed instead.
#
# Any other environment binds <env>.<domain> by cname-delegation, against the CNAME its own stack
# adds to the prod zone (infra/dns-subdomain.bicep).
#
# Only the apex can be made the site's default domain, and only in the portal; see
# docs/RUNBOOK.md, "Canonical host".
set -euo pipefail
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: scripts/bind-custom-domain.sh <env> [--apex-only]  (ZONE_NAME=<domain> before the stack manages the zone)" >&2; exit 2; }
ENV_NAME=$1
APEX_ONLY=false
[ "${2:-}" != --apex-only ] || APEX_ONLY=true
[ $# -eq 1 ] || [ "$APEX_ONLY" = true ] || { echo "unknown option: $2" >&2; exit 2; }
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
[ -s "$ENV_FILE" ] || die "no settings for $ENV_NAME; run scripts/bootstrap.sh $ENV_NAME first"
az_sub
SWA=$(aget SWA_NAME)
RG=$(aget AZURE_RESOURCE_GROUP)
[ -n "$SWA" ] && [ -n "$RG" ] || die "SWA_NAME or AZURE_RESOURCE_GROUP missing from $ENV_FILE; run scripts/provision.sh $ENV_NAME"
# The zone: the stack's setting, or during a migration the zone the stack does not manage yet
# (ZONE=atlasrelay.org in the environment).
ZONE=$(aget ATLASRELAY_DNS_ZONE)
MANAGED=true
if [ -z "$ZONE" ]; then
  ZONE=${ZONE_NAME:-}
  MANAGED=false
fi
[ -n "$ZONE" ] || die "no domain: set ATLASRELAY_DNS_ZONE (scripts/bootstrap.sh $ENV_NAME --domain NAME)"
if [ "$ENV_NAME" = prod ]; then ZONE_RG=$RG; else ZONE_RG=rg-atlasrelay-prod; fi
[ "$APEX_ONLY" = false ] || [ "$ENV_NAME" = prod ] || die "--apex-only is for prod"
[ "$MANAGED" = true ] || [ "$APEX_ONLY" = true ] || die "ATLASRELAY_DNS_ZONE is not set; only --apex-only works before the stack manages the zone"

# Bind one hostname. A conflict counts as done only when this site already holds the hostname (a
# previous run got there first). Azure answers the same way when another site holds it, and
# anything else is fatal, so a failed binding can never be mistaken for a pending one.
bind() {
  local host="$1" method="$2" out rc
  out="$(az staticwebapp hostname set -n "$SWA" -g "$RG" "${AZ_SUB[@]}" \
    --hostname "$host" --validation-method "$method" --no-wait -o none 2>&1)" && rc=0 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "  requested: $host ($method)"
  elif grep -qiE 'already exists|conflict|is already configured' <<<"$out" &&
    az staticwebapp hostname show -n "$SWA" -g "$RG" "${AZ_SUB[@]}" --hostname "$host" -o none 2>/dev/null; then
    echo "  already bound: $host"
  else
    echo "$out" >&2
    die "could not bind $host (a hostname bound to another site in the same slice has to be removed there first; see docs/RUNBOOK.md)"
  fi
}

log "Checking delegation of $ZONE"
# Newline-separated strings rather than arrays: mapfile needs bash 4, and macOS ships bash 3.2.
expected="$(az network dns zone show -n "$ZONE" -g "$ZONE_RG" "${AZ_SUB[@]}" \
  --query nameServers -o tsv | sed 's/\.$//' | tr 'A-Z' 'a-z' | sort)"
[[ -n "$expected" ]] || die "zone $ZONE not found in $ZONE_RG"
# Ask the parent zone's nameservers, not a recursive resolver. The parent is authoritative for
# the delegation, whereas recursors serve stale negative answers for a while after a change.
parent="${ZONE#*.}"
parent_ns="$(dig +short NS "$parent." | head -1)"
[[ -n "$parent_ns" ]] || die "could not find nameservers for the parent zone $parent"
actual="$(dig +norecurse "@$parent_ns" "$ZONE" NS +noall +authority \
  | awk '$4=="NS"{print tolower($5)}' | sed 's/\.$//' | sort)"
echo "  parent zone:  $parent (via $parent_ns)"
echo "  expected:     $(tr '\n' ' ' <<<"$expected")"
echo "  delegated:    $(tr '\n' ' ' <<<"${actual:-<none>}")"
[[ -n "$actual" ]] || die "$ZONE is not delegated yet; set the nameservers at the registrar and wait"
# Every Azure nameserver must be present: a partial delegation resolves intermittently.
missing="$(comm -23 <(echo "$expected") <(echo "$actual"))"
[[ -z "$missing" ]] || die "delegation incomplete, missing: $(tr '\n' ' ' <<<"$missing")"
echo "  all $(grep -c . <<<"$expected") nameservers delegated at the parent"

if [ "$ENV_NAME" != prod ]; then
  log "Binding $ENV_NAME.$ZONE"
  bind "$ENV_NAME.$ZONE" cname-delegation
else
  log "Binding hostnames"
  [ "$APEX_ONLY" = true ] || bind "www.$ZONE" cname-delegation
  bind "$ZONE" dns-txt-token

  log "Waiting for the apex validation token"
  token=""
  for _ in $(seq 1 30); do
    token="$(az staticwebapp hostname show -n "$SWA" -g "$RG" "${AZ_SUB[@]}" --hostname "$ZONE" \
      --query validationToken -o tsv 2>/dev/null || true)"
    [[ -n "$token" && "$token" != "null" ]] && break
    sleep 6
  done
  if [[ -n "$token" && "$token" != "null" ]]; then
    echo "  token: $token"
    [ "$(aget ATLASRELAY_SWA_APEX_TOKEN)" = "$token" ] || aset ATLASRELAY_SWA_APEX_TOKEN "$token"
    # Publish whenever the zone lacks it, so a run interrupted after saving it still gets there.
    published="$(az network dns record-set txt show -g "$ZONE_RG" -z "$ZONE" -n @ "${AZ_SUB[@]}" \
      --query "TXTRecords[].value[]" -o tsv 2>/dev/null || true)"
    if grep -Fxq "$token" <<<"$published"; then
      echo "  already published at the apex"
    elif [ "$MANAGED" = true ]; then
      log "Publishing the token (scripts/provision.sh $ENV_NAME)"
      provision
    else
      echo "  saved as ATLASRELAY_SWA_APEX_TOKEN. The stack does not manage $ZONE yet, so publish it by hand:"
      echo "      az network dns record-set txt add-record ${AZ_SUB[*]} -g $ZONE_RG -z $ZONE -n @ -v $token"
    fi
  else
    echo "  no token yet (an apex that is already validated has none); re-run this script to check again"
  fi
fi

log "Custom domain status"
az staticwebapp hostname list -n "$SWA" -g "$RG" "${AZ_SUB[@]}" \
  --query "[].{domain:name,status:status}" -o table

log "Resolution check"
hosts="$ZONE www.$ZONE"
[ "$ENV_NAME" = prod ] || hosts="$ENV_NAME.$ZONE"
for host in $hosts; do
  printf '  %-26s A=%s CNAME=%s\n' "$host" \
    "$(dig +short "$host" A @1.1.1.1 | tr '\n' ' ')" \
    "$(dig +short "$host" CNAME @1.1.1.1 | tr '\n' ' ')"
done
echo
echo "Until a hostname validates, the platform answers 404 for it. Apex validation is usually a"
echo "few minutes after the token is published, and can take longer."
