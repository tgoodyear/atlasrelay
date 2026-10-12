#!/usr/bin/env bash
# Stand a torn-down test environment (dev) up again, as it was, for a full-flow test run or a check
# by hand. scripts/dev-down.sh takes it down again afterwards. docs/RUNBOOK.md, "Dev on demand".
#
#   scripts/dev-up.sh [--env NAME] [--seed-vault VAULT] [--seed-subscription ID] [--no-approval]
#                     [--alert-email ADDRESS] [--ip ADDRESS]
#
#   --env NAME               the environment (default dev; never prod)
#   --seed-vault VAULT       where scripts/dev-down.sh saved its secrets (default: the setting
#                            E2E_SEED_VAULT)
#   --seed-subscription ID   the seed vault's subscription (default: the environment's)
#   --no-approval            let jobs in the GitHub Environment run without waiting for approval
#                            (scripts/bootstrap.sh)
#   --alert-email ADDRESS    deploy the alerts and the budget, sending to this address. Without it
#                            dev has none: the tests set alerts off on purpose
#   --ip ADDRESS             this machine's public IPv4 address (default: looked up at api.ipify.org)
#
# 1. With no settings file, takes the environment's inputs from the newest one scripts/teardown.sh
#    renamed (.azure/<env>/.env.deleted-<time>): subscription, location, repository, DNS zone,
#    operator, seed vault, and any sign-in client id set to empty (a provider turned off). The alert
#    address, the stack's outputs and the other client ids are not copied; the deployment and the
#    sign-in vault supply the last two.
# 2. scripts/bootstrap.sh: the stack, the GitHub Environment and DEV_ENABLED. Within 7 days of the
#    teardown it recovers the sign-in vault with its secrets; later, it creates an empty one.
# 3. scripts/dev-secrets.sh --restore: the test accounts and RIPE Atlas keys into the new test
#    vault, and any sign-in client id or secret the sign-in vault lacks.
# 4. scripts/provision.sh, so the site gets the sign-in registrations from the vault, then
#    scripts/register-signin.sh <env> aad, which registers the new site hostname's redirect URI with
#    Microsoft, points Microsoft's trust at the new sign-in identity and sets DEV_SIGNIN_PROVIDERS.
#
# Then run the tests (gh workflow run e2e-dev.yml --ref main, or scripts/run-e2e.sh dev), and bind
# dev.<domain> with scripts/bind-custom-domain.sh if you need GitHub, Google or ORCID sign-in, which
# are registered for that hostname only.
#
# Needs what scripts/bootstrap.sh and scripts/dev-secrets.sh need: az, gh, jq and curl, signed in as
# the operator with Owner on the subscription and admin on the repository.
set -euo pipefail
usage() { awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 2; }
ENV_NAME=dev SEED_ARGS=() BOOT_ARGS=() IP_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME=${2:-}; shift 2 ;;
    --seed-vault|--seed-subscription) [ $# -ge 2 ] || usage; SEED_ARGS+=("$1" "$2"); shift 2 ;;
    --no-approval) BOOT_ARGS+=(--no-approval); shift ;;
    --alert-email) [ $# -ge 2 ] || usage; BOOT_ARGS+=(--alert-email "$2"); shift 2 ;;
    --ip) [ $# -ge 2 ] || usage; IP_ARGS+=(--ip "$2"); shift 2 ;;
    *) usage ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
[ "$ENV_NAME" != prod ] || die "prod is never torn down between uses"
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
# scripts/register-signin.sh draws the Entra app's logo with the web workspace's packages.
[ -d node_modules ] || die "run npm ci in this working tree first (scripts/register-signin.sh needs it)"

# The inputs a stand-up needs from the last settings file. Everything else is a stack output, or a
# client id the sign-in vault holds.
# Not the alert address: a stand-up is for tests, which set off alerts on purpose (pass
# --alert-email for alerts and a budget). A sign-in client id set to empty is carried as empty, since
# that is how a provider is turned off (scripts/lib/env.sh, sync_client_ids); one with a value is
# not, and comes from the sign-in vault.
CARRIED="AZURE_SUBSCRIPTION_ID AZURE_LOCATION ATLASRELAY_GITHUB_REPO ATLASRELAY_DNS_ZONE
ATLASRELAY_DNS_TTL ATLASRELAY_OPERATOR_PRINCIPAL_ID E2E_SEED_VAULT"
CLIENT_IDS="ATLASRELAY_GITHUB_CLIENT_ID ATLASRELAY_MICROSOFT_CLIENT_ID ATLASRELAY_GOOGLE_CLIENT_ID
ATLASRELAY_ORCID_CLIENT_ID"
if [ ! -s "$ENV_FILE" ]; then
  # Names end in a UTC time stamp, so the last in sort order is the newest.
  last=$(find "$(dirname "$ENV_FILE")" -maxdepth 1 -name '.env.deleted-*' 2> /dev/null | sort | tail -n 1)
  [ -n "$last" ] || die "no settings for $ENV_NAME, current or torn down; stand it up the first time with scripts/bootstrap.sh $ENV_NAME (docs/RUNBOOK.md, \"Dev environment\")"
  step "Settings from $last"
  for k in $CARRIED; do
    v=$(ENV_FILE=$last aget "$k")
    [ -z "$v" ] || { aset "$k" "$v"; echo "  $k"; }
  done
  for k in $CLIENT_IDS; do
    if grep -q "^$k=" "$last" && [ -z "$(ENV_FILE=$last aget "$k")" ]; then
      aset "$k" ""
      echo "  $k (empty: that provider stays off)"
    fi
  done
fi
[ -n "$(aget AZURE_SUBSCRIPTION_ID)" ] || die "$ENV_FILE names no subscription"

step "scripts/bootstrap.sh $ENV_NAME"
scripts/bootstrap.sh "$ENV_NAME" ${BOOT_ARGS[@]+"${BOOT_ARGS[@]}"}

step "Restoring the secrets"
scripts/dev-secrets.sh --env "$ENV_NAME" --restore ${SEED_ARGS[@]+"${SEED_ARGS[@]}"} ${IP_ARGS[@]+"${IP_ARGS[@]}"}

step "Sign-in registrations"
# Takes the client ids from the sign-in vault into the settings, and gives the site their settings.
scripts/provision.sh "$ENV_NAME"
if [ -n "$(aget ATLASRELAY_MICROSOFT_CLIENT_ID)" ]; then
  scripts/register-signin.sh "$ENV_NAME" aad
else
  echo "no Microsoft registration in the sign-in vault: the site uses the built-in GitHub and Microsoft sign-in"
  echo "(scripts/register-signin.sh $ENV_NAME to register them; docs/RUNBOOK.md, \"Sign-in registrations\")"
fi

step "Done"
echo "$ENV_NAME is up at https://$(aget SWA_HOSTNAME)."
echo "Full-flow tests: gh workflow run e2e-dev.yml --ref main, or scripts/run-e2e.sh $ENV_NAME"
zone=$(aget ATLASRELAY_DNS_ZONE)
[ -z "$zone" ] || echo "For GitHub, Google and ORCID sign-in on $ENV_NAME.$zone: scripts/bind-custom-domain.sh $ENV_NAME"
echo "Take it down again when you are done: scripts/dev-down.sh --env $ENV_NAME"
