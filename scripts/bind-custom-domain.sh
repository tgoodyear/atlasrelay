#!/usr/bin/env bash
# Bind the custom domain to the Static Web App. Run this AFTER the registrar delegates the
# domain to the Azure nameservers and the delegation is visible in public DNS.
#
#   ./scripts/bind-custom-domain.sh [zone] [static-web-app] [resource-group]
#
# www uses cname-delegation (the CNAME already exists in the zone).
# The apex uses dns-txt-token: Azure issues a token, which must be published as a TXT record at
# the apex. Record the token in infra/main.bicepparam (dnsApexTxtValues) so that Bicep, which is
# the only writer of this zone, does not remove it on the next deployment.
set -euo pipefail

ZONE="${1:-atlasrelay.org}"
SWA="${2:-swa-internetresearch}"
RG="${3:-internetresearch}"
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-25bf257c-c94e-4d61-bba3-edc635f46602}"
SUB=(--subscription "$SUBSCRIPTION_ID")

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

log "Checking delegation of $ZONE"
expected="$(az network dns zone show -n "$ZONE" -g "$RG" "${SUB[@]}" --query nameServers -o tsv | sed 's/\.$//' | sort)"
actual="$(dig +short NS "$ZONE" @1.1.1.1 | sed 's/\.$//' | sort)"
echo "  expected: $(tr '\n' ' ' <<<"$expected")"
echo "  public:   $(tr '\n' ' ' <<<"${actual:-<none>}")"
[[ -n "$actual" ]] || die "$ZONE is not delegated yet; set the nameservers at the registrar and wait for propagation"
comm -12 <(echo "$expected") <(echo "$actual") | grep -q . \
  || die "public nameservers do not match the Azure zone; check the registrar"

log "Binding www.$ZONE (cname-delegation)"
az staticwebapp hostname set -n "$SWA" -g "$RG" "${SUB[@]}" \
  --hostname "www.$ZONE" --validation-method cname-delegation -o none || true

log "Binding apex $ZONE (dns-txt-token)"
az staticwebapp hostname set -n "$SWA" -g "$RG" "${SUB[@]}" \
  --hostname "$ZONE" --validation-method dns-txt-token --no-wait -o none || true

log "Validation token for the apex"
for _ in $(seq 1 20); do
  token="$(az staticwebapp hostname show -n "$SWA" -g "$RG" "${SUB[@]}" --hostname "$ZONE" \
    --query validationToken -o tsv 2>/dev/null || true)"
  [[ -n "$token" && "$token" != "null" ]] && break
  sleep 6
done
if [[ -n "${token:-}" && "$token" != "null" ]]; then
  echo "  token: $token"
  echo
  echo "  Add it to infra/main.bicepparam so Bicep keeps it:"
  echo "      param dnsApexTxtValues = [ '$token' ]"
  echo "  then re-run the subscription deployment (see docs/RUNBOOK.md)."
else
  echo "  no token returned yet; re-run this script in a few minutes"
fi

log "Current custom domains"
az staticwebapp hostname list -n "$SWA" -g "$RG" "${SUB[@]}" \
  --query "[].{domain:name,status:status}" -o table
