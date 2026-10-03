#!/usr/bin/env bash
# Checks infra/main.bicepparam against the settings it reads, without Azure:
# 1. It compiles for prod and for dev, with placeholder settings, so a parameter that main.bicep
#    rejects (a bad default, an environment name the storage account can't hold) fails here. prod's
#    resource group lock is on for prod and off for dev.
# 2. Every setting it reads, and every stack output, is listed in .azure/env.example, and every
#    setting listed there is read by it, written by the scripts (aset), or a stack output.
# 3. The test cleanup route (E2E_PROJECT_CLEANUP) can never reach prod: prod's parameters turn the
#    test harness off, and the compiled template sets the setting only through the harness flag,
#    which is also false whenever the environment is prod.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v jq > /dev/null || { echo "jq is not installed" >&2; exit 1; }
status=0
for env in prod dev; do
  if ! params=$(AZURE_ENV_NAME=$env ATLASRELAY_GITHUB_OIDC_SUBJECT_PREFIX='repo:placeholder@0/placeholder@0' \
    az bicep build-params --file infra/main.bicepparam --stdout); then
    echo "infra/main.bicepparam does not compile for $env" >&2
    status=1
    continue
  fi
  harness=$(jq -r '.parametersJson | fromjson | .parameters.testHarness.value' <<< "$params")
  want=true
  [ "$env" = prod ] && want=false
  [ "$harness" = "$want" ] ||
    { echo "infra/main.bicepparam sets testHarness to $harness for $env, not $want" >&2; status=1; }
  # prod's resource group lock (infra/lock.bicep) is on for prod and off everywhere else.
  lock=$(jq -r '.parametersJson | fromjson | .parameters.resourceGroupLock.value' <<< "$params")
  want=false
  [ "$env" = prod ] && want=true
  [ "$lock" = "$want" ] ||
    { echo "infra/main.bicepparam sets resourceGroupLock to $lock for $env, not $want" >&2; status=1; }
done

# The compiled template, so this checks what ARM evaluates rather than how the source is written.
main_json=$(az bicep build --file infra/main.bicep --stdout)
# The module list is an array or, with symbolic names, an object; either way, the API module.
api_module='.resources | (if type == "object" then [.[]] else . end) | map(select(.name == "api"))[0]'
cleanup_checks=(
  ".variables.isProd == \"[equals(variables('env'), 'prod')]\""
  ".variables.harness == \"[and(parameters('testHarness'), not(variables('isProd')))]\""
  "$api_module.properties.parameters.testCleanup.value == \"[variables('harness')]\""
  "$api_module.properties.template.parameters.testCleanup.defaultValue == false"
  "$api_module.properties.template.variables.testCleanupAppSettings == \"[if(parameters('testCleanup'), createObject('E2E_PROJECT_CLEANUP', '1'), createObject())]\""
)
for check in "${cleanup_checks[@]}"; do
  [ "$(jq "$check" <<< "$main_json")" = true ] ||
    { echo "infra/main.bicep: the test cleanup gate changed; expected $check" >&2; status=1; }
done
# Two mentions in the whole compiled stack: the gated setting, and the filter that drops it from
# additionalAppSettings. A third would be another way to set it.
mentions=$(grep -o "E2E_PROJECT_CLEANUP" <<< "$main_json" | wc -l | tr -d ' ')
[ "$mentions" = 2 ] ||
  { echo "infra/main.bicep: E2E_PROJECT_CLEANUP appears $mentions times in the compiled template, expected 2" >&2; status=1; }
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
[ $status -eq 0 ] && echo "infra/main.bicepparam compiles for prod and dev; .azure/env.example lists its settings; prod cannot have the test cleanup route"
exit $status
