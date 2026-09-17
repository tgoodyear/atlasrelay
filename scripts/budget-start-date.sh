#!/usr/bin/env bash
# Prints the budget period start date (YYYY-MM-DD) to use for the platform deployment.
# Azure only accepts a start date inside the current month when a budget is created, and the
# date should stay fixed afterwards, so: reuse the existing budget's date, else the current month.
# Any failure other than "budget not found" is fatal so a deploy never silently re-bases the period.
#
#   BUDGET_START_DATE="$(scripts/budget-start-date.sh <subscription-id> <resource-group> [budget-name])"
set -euo pipefail
sub="${1:?subscription id}"
rg="${2:?resource group}"
name="${3:-internetresearch-monthly}"
url="https://management.azure.com/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Consumption/budgets/$name?api-version=2023-11-01"
if out="$(az rest --method get --url "$url" --query properties.timePeriod.startDate -o tsv 2>&1)"; then
  [[ -n "$out" ]] || { echo "budget $name exists but has no startDate" >&2; exit 1; }
  echo "${out:0:10}"
elif grep -qiE 'NotFound|"code": *"404"|does not exist|could not be found' <<<"$out"; then
  date -u +%Y-%m-01
else
  echo "could not read budget $name: $out" >&2
  exit 1
fi
