using './app.bicep'

param baseName = 'internetresearch'
param location = 'westus2'
param swaLocation = 'westus2'
param swaSku = 'Free'
param stagingEnvironmentPolicy = 'Disabled'
param enableApplicationInsights = true
param budgetAmount = 120
param budgetContactEmail = readEnvironmentVariable('BUDGET_CONTACT_EMAIL', 'trevor.goodyear@gmail.com')
// Provided by scripts/budget-start-date.sh: the existing budget's start date, else the current month.
param budgetStartDate = readEnvironmentVariable('BUDGET_START_DATE', '2026-09-01')
param tags = {
  project: 'atlas-credit-exchange'
  repo: 'tgoodyear/internetresearch'
}
