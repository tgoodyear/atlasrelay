// Log Analytics, workspace-based Application Insights and the monthly budget.
// Alerts, the availability test and the workbook are in monitoring.bicep.
targetScope = 'resourceGroup'

@description('Base name used for resources, e.g. atlasrelay-prod')
param baseName string

param location string = resourceGroup().location

@description('Daily ingestion cap for Log Analytics in GB (0.1 GB/day is about 3 GB/month)')
param logDailyCapGb string = '0.1'

param budgetName string

@description('Monthly budget (alerts only) in USD')
param budgetAmount int = 120

@description('First day of the budget period (YYYY-MM-01). Must be the current month on first creation and fixed afterwards. Empty skips the budget.')
param budgetStartDate string = ''

@description('Address that receives budget notifications. Empty skips the budget.')
param alertEmail string = ''

param tags object = {}

// The privacy page (web/src/pages/Privacy.tsx) says usage statistics and logs are deleted after
// 90 days. Everything the site and the API send lands in these tables, so their retention is
// declared here rather than left to the service default.
var appTables = [
  'AppAvailabilityResults'
  'AppBrowserTimings'
  'AppDependencies'
  'AppEvents'
  'AppExceptions'
  'AppMetrics'
  'AppPageViews'
  'AppPerformanceCounters'
  'AppRequests'
  'AppSystemEvents'
  'AppTraces'
]
var appRetentionDays = 90

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
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

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${baseName}'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    IngestionMode: 'LogAnalytics'
    DisableLocalAuth: false
  }
}

// The App* tables appear in the workspace once the component is linked to it.
@batchSize(1)
resource appTableRetention 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = [
  for t in appTables: {
    parent: logs
    name: t
    properties: {
      retentionInDays: appRetentionDays
      totalRetentionInDays: appRetentionDays
    }
    dependsOn: [appInsights]
  }
]

// Alerts only. The subscription's spending limit is the hard stop.
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = if (!empty(budgetStartDate) && !empty(alertEmail)) {
  name: budgetName
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
        contactEmails: [alertEmail]
      }
      actual80: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [alertEmail]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [alertEmail]
      }
    }
  }
}

output workspaceId string = logs.id
output workspaceName string = logs.name
output appInsightsId string = appInsights.id
output appInsightsName string = appInsights.name
output appInsightsConnectionString string = appInsights.properties.ConnectionString
