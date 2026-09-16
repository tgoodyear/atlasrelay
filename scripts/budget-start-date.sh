#!/usr/bin/env bash
# Prints the budget period start date to use for infra deployments.
# Azure only accepts a start date inside the current month when a budget is created, and the
# date should stay fixed afterwards, so: reuse the existing budget's date, else the current month.
#
#   BUDGET_START_DATE="$(scripts/budget-start-date.sh <subscription-id> <resource-group> [budget-name])"
set -euo pipefail
sub="${1:?subscription id}"
rg="${2:?resource group}"
name="${3:-internetresearch-monthly}"
existing="$(az rest --method get \
  --url "https://management.azure.com/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Consumption/budgets/$name?api-version=2023-11-01" \
  --query properties.timePeriod.startDate -o tsv 2>/dev/null || true)"
if [[ -n "$existing" ]]; then
  echo "${existing:0:10}"
else
  date -u +%Y-%m-01
fi
