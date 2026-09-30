#!/usr/bin/env bash
# Read or change an environment's settings (.azure/<env>/.env).
#
#   scripts/settings.sh prod                 # all of them
#   scripts/settings.sh prod SWA_NAME        # one
#   scripts/settings.sh prod KEY VALUE       # set one ("" clears it)
#
# A change takes effect in Azure on the next scripts/provision.sh (or bootstrap) run. The stack's
# outputs (SWA_NAME, CI_CLIENT_ID, ...) are rewritten by every deployment. .azure/env.example
# lists the settings.
set -euo pipefail
[ $# -ge 1 ] && [ $# -le 3 ] || { sed -n '2,10s/^# \{0,1\}//p' "$0" >&2; exit 2; }
ENV_NAME=$1
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
[ -e "$ENV_FILE" ] || [ $# -eq 3 ] ||
  { echo "error: no settings for $ENV_NAME" >&2; exit 1; }
case $# in
  1) cat "$ENV_FILE" ;;
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
    aset "$2" "$3" ;;
esac
