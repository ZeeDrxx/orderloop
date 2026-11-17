using './main.bicep'

param prefix = 'orderloop'
// Secrets come from the environment, never from this file:
//   export OL_PG_PASSWORD=$(openssl rand -hex 20)
//   export OL_SAP_API_KEY=<key from api.sap.com → your profile → Show API Key>
param postgresPassword = readEnvironmentVariable('OL_PG_PASSWORD')
param sapApiKey = readEnvironmentVariable('OL_SAP_API_KEY', '')
param clientIp = readEnvironmentVariable('OL_CLIENT_IP', '')
