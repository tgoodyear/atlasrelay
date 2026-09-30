#!/usr/bin/env bash
# Checks infra/main.bicepparam against the settings it reads, without Azure:
# 1. It compiles for prod and for dev, with placeholder settings, so a parameter that main.bicep
#    rejects (a bad default, an environment name the storage account can't hold) fails here.
# 2. Every setting it reads, and every stack output, is listed in .azure/env.example, and every
#    setting listed there is read by it, written by the scripts (aset), or a stack output.
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
for env in prod dev; do
  AZURE_ENV_NAME=$env ATLASRELAY_GITHUB_OIDC_SUBJECT_PREFIX='repo:placeholder@0/placeholder@0' \
    az bicep build-params --file infra/main.bicepparam --stdout > /dev/null ||
    { echo "infra/main.bicepparam does not compile for $env" >&2; status=1; }
done
read_keys=$(grep -o "readEnvironmentVariable('[A-Za-z0-9_]*'" infra/main.bicepparam | cut -d"'" -f2 | sort -u)
example_keys=$(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' .azure/env.example | sort -u)
output_keys=$(grep -o '^output [A-Z_][A-Z0-9_]*' infra/main.bicep | cut -d' ' -f2 | sort -u)
missing=$(comm -23 <(echo "$read_keys") <(echo "$example_keys"))
if [ -n "$missing" ]; then
  echo "settings read by infra/main.bicepparam but missing from .azure/env.example: $(tr '\n' ' ' <<< "$missing")" >&2
  status=1
fi
missing=$(comm -23 <(echo "$output_keys") <(echo "$example_keys"))
if [ -n "$missing" ]; then
  echo "stack outputs missing from .azure/env.example: $(tr '\n' ' ' <<< "$missing")" >&2
  status=1
fi
script_keys=$(grep -ho 'aset [A-Z_][A-Z0-9_]*' scripts/*.sh scripts/lib/*.sh | cut -d' ' -f2)
known=$(printf '%s\n%s\n%s\n' "$read_keys" "$output_keys" "$script_keys" | grep -v '^$' | sort -u)
unknown=$(comm -23 <(echo "$example_keys") <(echo "$known"))
if [ -n "$unknown" ]; then
  echo "settings in .azure/env.example that nothing reads or writes: $(tr '\n' ' ' <<< "$unknown")" >&2
  status=1
fi
[ $status -eq 0 ] && echo "infra/main.bicepparam compiles for prod and dev; .azure/env.example lists its settings"
exit $status
