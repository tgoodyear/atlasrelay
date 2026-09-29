// Owner-only platform resources: monitoring and the cost guardrail.
// Deployed from main.bicep. Kept out of app.bicep so the CI identity cannot raise the Log
// Analytics cap or SKU, change App Insights, its alerts or availability test, or delete/raise the
// budget. Alerts, the availability test and the workbook are in monitoring.bicep.
targetScope = 'resourceGroup'

@description('Base name used for resources')
@minLength(3)
@maxLength(20)
param baseName string = 'internetresearch'

param location string = resourceGroup().location

@description('Application Insights + Log Analytics for API logs (free tier, daily cap enforced)')
param enableApplicationInsights bool = true

@description('Daily ingestion cap for Log Analytics in GB (0.1 GB/day ≈ 3 GB/month, inside the 5 GB free allowance)')
param logDailyCapGb string = '0.1'

@description('Monthly budget (alerts only) in USD for the resource group')
param budgetAmount int = 120

@description('Email that receives budget alerts')
param budgetContactEmail string

@description('First day of the budget period (YYYY-MM-01). Must be the current month on first creation; reuse the existing value afterwards (scripts/budget-start-date.sh).')
param budgetStartDate string

@description('Email that receives monitoring alerts')
param alertEmail string

@description('Page the availability test requests, e.g. https://atlasrelay.org/. Empty skips the test.')
param availabilityTestUrl string = ''

param tags object = {}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (enableApplicationInsights) {
  name: 'log-${baseName}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json(logDailyCapGb)
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = if (enableApplicationInsights) {
  name: 'appi-${baseName}'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs!.id
    IngestionMode: 'LogAnalytics'
    RetentionInDays: 30
    DisableLocalAuth: false
  }
}

module monitoring 'monitoring.bicep' = if (enableApplicationInsights) {
  name: 'monitoring'
  params: {
    baseName: baseName
    location: location
    tags: tags
    workspaceId: logs!.id
    appInsightsId: appInsights!.id
    alertEmail: alertEmail
    availabilityTestUrl: availabilityTestUrl
  }
}

// Alerts only. The subscription's spending limit is the hard stop.
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: '${baseName}-monthly'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      actual50: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [budgetContactEmail]
      }
      actual80: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [budgetContactEmail]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [budgetContactEmail]
      }
    }
  }
}

output appInsightsName string = enableApplicationInsights ? appInsights!.name : ''
output workspaceName string = enableApplicationInsights ? logs!.name : ''
// Compiled into the browser bundle by the Deploy workflow (scripts/bootstrap.sh copies it to the
// repository variable APPINSIGHTS_CONNECTION_STRING). It names the ingestion endpoint and the
// instrumentation key; it is not a credential and is public once the site ships it.
output appInsightsConnectionString string = enableApplicationInsights ? appInsights!.properties.ConnectionString : ''
