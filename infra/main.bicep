// OrderLoop on Azure: the scheduled SAP sync and the database it fills.
//
//   Azure Functions (Flex Consumption, Node 22) ── hourly ──► SAP S/4HANA Cloud OData APIs
//          │  managed identity                                 (sandbox API key or communication user)
//          ├──► Key Vault: SAP credentials, database URL
//          └──► PostgreSQL Flexible Server ◄── Power BI (read-only role) · dashboard
//
// Deploy: az deployment group create -g <rg> -f infra/main.bicep -p infra/main.bicepparam

targetScope = 'resourceGroup'

@minLength(3)
@maxLength(10)
param prefix string = 'orderloop'
param location string = resourceGroup().location

@secure()
@description('PostgreSQL admin password (letters and digits only: it goes into a connection URL).')
param postgresPassword string

@secure()
@description('SAP Business Accelerator Hub API key (sandbox). Leave empty when using SAP_USER/SAP_PASSWORD.')
param sapApiKey string = ''

@description('SAP OData base URL: sandbox by default, or https://<tenant>-api.s4hana.cloud.sap/sap/opu/odata/sap')
param sapBaseUrl string = 'https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap'

@description('NCRONTAB schedule for the sync (six fields).')
param syncSchedule string = '0 0 * * * *'

@description('Your public IP, to allow Power BI Desktop / psql to reach PostgreSQL. Empty = no rule.')
param clientIp string = ''

var suffix = uniqueString(resourceGroup().id)
var pgAdmin = 'oladmin'

// ---------------------------------------------------------------- monitoring

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs-${suffix}'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-insights'
  location: location
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id, DisableLocalAuth: true }
}

// ---------------------------------------------------------------- storage (Functions runtime + deployment package)

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('${prefix}st${suffix}', 24)
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false // identity-based access only
    minimumTlsVersion: 'TLS1_2'
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource deployments 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'deployments'
}

// ---------------------------------------------------------------- PostgreSQL

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg-${suffix}'
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: pgAdmin
    administratorLoginPassword: postgresPassword
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'orderloop'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource pgAllowClient 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (!empty(clientIp)) {
  parent: postgres
  name: 'AllowClient'
  properties: { startIpAddress: clientIp, endIpAddress: clientIp }
}

// ---------------------------------------------------------------- Key Vault

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: take('${prefix}-kv-${suffix}', 24)
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
  }
}

resource secretDb 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-url'
  properties: { value: 'postgres://${pgAdmin}:${postgresPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/orderloop' }
}

resource secretSap 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'sap-api-key'
  properties: { value: empty(sapApiKey) ? 'unset' : sapApiKey }
}

// ---------------------------------------------------------------- Function App (Flex Consumption)

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${prefix}-plan'
  location: location
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}

resource functions 'Microsoft.Web/sites@2024-04-01' = {
  name: '${prefix}-fn-${suffix}'
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deployments.name}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: { maximumInstanceCount: 40, instanceMemoryMB: 2048 }
      runtime: { name: 'node', version: '22' }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
        { name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING', value: 'Authorization=AAD' }
        { name: 'SYNC_SCHEDULE', value: syncSchedule }
        { name: 'SAP_BASE_URL', value: sapBaseUrl }
        { name: 'SAP_API_KEY', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${secretSap.name})' }
        { name: 'DATABASE_URL', value: '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${secretDb.name})' }
        { name: 'PGSSLMODE', value: 'require' }
      ]
    }
  }
}

// ---------------------------------------------------------------- role assignments for the Function App identity

var roles = {
  storageBlobDataOwner: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
  storageQueueDataContributor: '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  monitoringMetricsPublisher: '3913510d-42f4-4e42-8a64-420c390055eb'
}

resource storageRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in [roles.storageBlobDataOwner, roles.storageQueueDataContributor, roles.storageTableDataContributor]: {
  name: guid(storage.id, functions.id, role)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role)
    principalId: functions.identity.principalId
    principalType: 'ServicePrincipal'
  }
}]

resource vaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, functions.id, roles.keyVaultSecretsUser)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
    principalId: functions.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource insightsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(insights.id, functions.id, roles.monitoringMetricsPublisher)
  scope: insights
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.monitoringMetricsPublisher)
    principalId: functions.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output functionAppName string = functions.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output keyVaultName string = vault.name
