// Parameters for infra/main.bicep, from the environment's settings (.azure/<env>/.env).
// scripts/provision.sh exports the settings that have a value before it deploys the stack; the
// rest take the defaults here. .azure/env.example lists every setting.
using './main.bicep'

param environmentName = readEnvironmentVariable('AZURE_ENV_NAME')
param location = readEnvironmentVariable('AZURE_LOCATION', 'westus2')
param swaLocation = 'westus2'
param stagingEnvironmentPolicy = 'Disabled'
param githubRepo = readEnvironmentVariable('ATLASRELAY_GITHUB_REPO', 'tgoodyear/atlasrelay')
param githubOidcSubjectPrefix = readEnvironmentVariable('ATLASRELAY_GITHUB_OIDC_SUBJECT_PREFIX')
param logDailyCapGb = '0.1'
// The next two are for moving an environment off managed functions only (docs/RUNBOOK.md).
param storageSharedKeyAccess = bool(readEnvironmentVariable('ATLASRELAY_STORAGE_SHARED_KEY', 'false'))
param linkApi = !bool(readEnvironmentVariable('ATLASRELAY_API_UNLINKED', 'false'))
param operatorPrincipalId = readEnvironmentVariable('ATLASRELAY_OPERATOR_PRINCIPAL_ID', '')
param additionalAppSettings = {}
param alertEmail = readEnvironmentVariable('ATLASRELAY_ALERT_EMAIL', '')
param budgetAmount = 120
param budgetStartDate = readEnvironmentVariable('ATLASRELAY_BUDGET_START', '')
param dnsZoneName = readEnvironmentVariable('ATLASRELAY_DNS_ZONE', '')
param dnsTtl = int(readEnvironmentVariable('ATLASRELAY_DNS_TTL', '3600'))
// Google Search Console domain verification, published at the apex next to SPF. Public, so it
// lives in git. The Static Web Apps apex token is per site and lives in the settings instead.
param dnsApexTxtValues = {
  'atlasrelay.org': ['google-site-verification=PmPeiS951f6LV0yLSeciOw2VCg8GoDdKAQTllGN6fkQ']
}
param swaApexToken = readEnvironmentVariable('ATLASRELAY_SWA_APEX_TOKEN', '')
