#!/usr/bin/env bash
# Read or change an environment's settings (.azure/<env>/.env).
#
#   scripts/settings.sh prod                 # all of them, secrets masked
#   scripts/settings.sh prod SWA_NAME        # one
#   scripts/settings.sh prod KEY VALUE       # set one ("" clears it)
#   scripts/settings.sh prod KEY -           # set one from a hidden prompt (secrets)
#
# A change takes effect in Azure on the next scripts/provision.sh (or bootstrap) run. The stack's
# outputs (SWA_NAME, CI_CLIENT_ID, ...) are rewritten by every deployment. .azure/env.example
# lists the settings.
set -euo pipefail
[ $# -ge 1 ] && [ $# -le 3 ] || { sed -n '2,11s/^# \{0,1\}//p' "$0" >&2; exit 2; }
ENV_NAME=$1
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
[ -e "$ENV_FILE" ] || [ $# -eq 3 ] ||
  { echo "error: no settings for $ENV_NAME" >&2; exit 1; }
case $# in
  # Client secrets (docs/RUNBOOK.md, "Google and ORCID sign-in") show as set or empty; read one
  # by name when it is really needed.
  1) sed -E 's/^([A-Z0-9_]*_SECRET)=".+"$/\1="(set)"/' "$ENV_FILE" ;;
  2) aget "$2" ;;
  3)
    # Changing these here would deploy a second copy elsewhere, past bootstrap's checks.
    case "$2" in
      AZURE_ENV_NAME|AZURE_SUBSCRIPTION_ID|AZURE_LOCATION)
        if [ "$(aget "$2")" != "$3" ] && [ -n "$(aget "$2")" ]; then
          echo "error: $2 is set by bootstrap; tear the environment down and bootstrap it again to change it" >&2
          exit 1
        fi ;;
    esac
    value=$3
    # "-" reads the value at a prompt that does not echo it, so a secret stays out of the shell
    # history and the process list.
    if [ "$value" = - ]; then
      [ -t 0 ] || { echo "error: $2 -: run it in a terminal" >&2; exit 1; }
      IFS= read -rsp "$2: " value
      echo
    fi
    aset "$2" "$value" ;;
esac
