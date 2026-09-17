using './main.bicep'

// Deploy with scripts/bootstrap.sh: it exports GITHUB_OIDC_SUBJECT_PREFIX and BUDGET_START_DATE.
// Values marked (shared) must match infra/app.bicepparam; scripts/check-params.sh enforces it.
param resourceGroupName = 'internetresearch'
param location = 'westus2'
param baseName = 'internetresearch'                 // (shared)
param swaLocation = 'westus2'                        // (shared)
param swaSku = 'Free'                                // (shared)
param stagingEnvironmentPolicy = 'Disabled'          // (shared)
param enableApplicationInsights = true               // (shared)
param storageKeyIndex = 0                            // (shared)
param additionalAppSettings = {}                     // (shared)
param logDailyCapGb = '0.1'
param dnsZoneName = 'atlasrelay.org'
// Set by scripts/bind-custom-domain.sh once Azure issues the apex validation token.
param dnsApexTxtValues = []
param githubRepo = 'tgoodyear/internetresearch'
param githubOidcSubjectPrefix = readEnvironmentVariable('GITHUB_OIDC_SUBJECT_PREFIX')
param enablePullRequestFederation = false
param budgetAmount = 120
param budgetContactEmail = readEnvironmentVariable('BUDGET_CONTACT_EMAIL', 'trevor.goodyear@gmail.com')
param budgetStartDate = readEnvironmentVariable('BUDGET_START_DATE')
