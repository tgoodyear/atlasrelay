#!/usr/bin/env bash
# Bind the custom domain to the Static Web App. Run this AFTER the registrar delegates the
# domain to the Azure nameservers and the delegation is visible in public DNS.
#
#   ./scripts/bind-custom-domain.sh [zone] [static-web-app] [resource-group]
#
# www uses cname-delegation: the CNAME already exists in the zone (infra/dns.bicep).
# The apex uses dns-txt-token. Static Web Apps issues a token, publishes it as a TXT record and
# creates the apex ALIAS record that routes traffic to the site; the zone deliberately ships no
# apex A/ALIAS record of its own, because only the service knows the target to point at.
# Record the token in infra/main.bicepparam (dnsApexTxtValues) afterwards so that Bicep, which is
# the only writer of this zone, does not remove it on the next deployment.
set -euo pipefail

ZONE="${1:-atlasrelay.org}"
SWA="${2:-swa-internetresearch}"
RG="${3:-internetresearch}"
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-25bf257c-c94e-4d61-bba3-edc635f46602}"
SUB=(--subscription "$SUBSCRIPTION_ID")

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

# Bind one hostname. An "already exists" response means a previous run got there first, which is
# fine; anything else is fatal, so a failed binding can never be mistaken for a pending one.
bind() {
  local host="$1" method="$2" out rc
  out="$(az staticwebapp hostname set -n "$SWA" -g "$RG" "${SUB[@]}" \
    --hostname "$host" --validation-method "$method" --no-wait -o none 2>&1)" && rc=0 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "  requested: $host ($method)"
  elif grep -qiE 'already exists|conflict|is already configured' <<<"$out"; then
    echo "  already bound: $host"
  else
    echo "$out" >&2
    die "could not bind $host"
  fi
}

log "Checking delegation of $ZONE"
# Newline-separated strings rather than arrays: mapfile needs bash 4, and macOS ships bash 3.2.
expected="$(az network dns zone show -n "$ZONE" -g "$RG" "${SUB[@]}" \
  --query nameServers -o tsv | sed 's/\.$//' | tr 'A-Z' 'a-z' | sort)"
[[ -n "$expected" ]] || die "zone $ZONE not found in $RG"
actual="$(dig +short NS "$ZONE" @1.1.1.1 | sed 's/\.$//' | tr 'A-Z' 'a-z' | sort)"
echo "  expected: $(tr '\n' ' ' <<<"$expected")"
echo "  public:   $(tr '\n' ' ' <<<"${actual:-<none>}")"
[[ -n "$actual" ]] || die "$ZONE is not delegated yet; set the nameservers at the registrar and wait"
# Every Azure nameserver must be present, not merely one of them: a partial delegation resolves
# intermittently and makes domain validation fail in ways that are tedious to diagnose.
missing="$(comm -23 <(echo "$expected") <(echo "$actual"))"
[[ -z "$missing" ]] || die "delegation incomplete, missing: $(tr '\n' ' ' <<<"$missing")"
echo "  all $(grep -c . <<<"$expected") nameservers delegated"

log "Binding hostnames"
bind "www.$ZONE" cname-delegation
bind "$ZONE" dns-txt-token

log "Waiting for the apex validation token"
token=""
for _ in $(seq 1 30); do
  token="$(az staticwebapp hostname show -n "$SWA" -g "$RG" "${SUB[@]}" --hostname "$ZONE" \
    --query validationToken -o tsv 2>/dev/null || true)"
  [[ -n "$token" && "$token" != "null" ]] && break
  sleep 6
done
if [[ -n "$token" && "$token" != "null" ]]; then
  echo "  token: $token"
  echo
  echo "  Record it so Bicep keeps it, in infra/main.bicepparam:"
  echo "      param dnsApexTxtValues = [ '$token' ]"
  echo "  then re-run the subscription deployment (see docs/RUNBOOK.md)."
else
  echo "  no token yet; re-run this script in a few minutes"
fi

log "Custom domain status"
az staticwebapp hostname list -n "$SWA" -g "$RG" "${SUB[@]}" \
  --query "[].{domain:name,status:status}" -o table

log "Resolution check"
for host in "$ZONE" "www.$ZONE"; do
  printf '  %-26s A=%s CNAME=%s\n' "$host" \
    "$(dig +short "$host" A @1.1.1.1 | tr '\n' ' ')" \
    "$(dig +short "$host" CNAME @1.1.1.1 | tr '\n' ' ')"
done
echo
echo "The apex only routes once Static Web Apps finishes validation and creates its ALIAS record."
echo "Apex validation can take up to 72 hours, though it is usually much quicker."
