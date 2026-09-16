using './main.bicep'

param baseName = 'internetresearch'
param swaLocation = 'eastus2'
param swaSku = 'Free'
param budgetAmount = 120
// Overridden on the command line by scripts/bootstrap.sh and the infra workflow.
param budgetContactEmail = readEnvironmentVariable('BUDGET_CONTACT_EMAIL', 'trevor.goodyear@gmail.com')
param budgetStartDate = readEnvironmentVariable('BUDGET_START_DATE', '2026-09-01')
