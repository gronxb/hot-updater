# Azure environment

Read COMMON.md for secure credential handling. Discover the subscription,
resource group and existing deployment with the authenticated Azure CLI; create
missing storage, Cosmos DB and Function App resources as SETUP.md describes.
Ask only for unresolved subscription selection, authentication or prerequisites
that require the user's involvement.

Use env.example as a reference and set only applicable values in the app's ignored
.env.hotupdater. The supplied adapters connect with the accounts' connection
strings, which `az` reads; an `az login` session alone does not configure them.

| Variable                                      | Purpose and when needed                                                                                                                                                       | Where to obtain it                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `HOT_UPDATER_AZURE_SUBSCRIPTION_ID`           | Subscription of every resource; recorded for init reuse.                                                                                                                      | `az account list`: the subscription the user names or the only enabled one.                              |
| `HOT_UPDATER_AZURE_RESOURCE_GROUP`            | Resource group of every resource; recorded for init reuse.                                                                                                                    | Query or create the group and record its name.                                                           |
| `HOT_UPDATER_AZURE_LOCATION`                  | Region of a new resource group and its resources; recorded for init reuse.                                                                                                    | Read an existing group's region, or use the established deployment preference for a new one.             |
| `HOT_UPDATER_AZURE_STORAGE_ACCOUNT`           | Storage account of the bundles and the Function App; recorded for init reuse.                                                                                                 | Query or create the account and record its name.                                                         |
| `HOT_UPDATER_AZURE_COSMOS_ACCOUNT`            | Cosmos DB for NoSQL account of the database; recorded for init reuse.                                                                                                         | Query or create the account and record its name.                                                         |
| `HOT_UPDATER_AZURE_FUNCTION_APP`              | Function App that runs the server; recorded for init reuse.                                                                                                                   | Query or create the app and record its name.                                                             |
| `HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING` | Required by the supplied local storage config and app/hotUpdater.ts, the credential helper's server definition, which stays in the scaffold and is never copied into the app. | `az storage account show-connection-string`; save it privately.                                          |
| `HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING`  | Required by the supplied local database config and app/hotUpdater.ts.                                                                                                         | `az cosmosdb keys list --type connection-strings`: the primary SQL connection string; save it privately. |

<!-- if credential -->

| `{{CREDENTIAL_ENV}}` | The client {{CREDENTIAL_LABEL}}, sent in `{{CREDENTIAL_HEADER}}`; required after the container is ready. | Reuse the saved one or run app/provision-client-credential.mjs. Keep it private and stable on retries; do not use an account key as this {{CREDENTIAL_LABEL}}. |

<!-- end -->

## Function settings

The deployed Function reads the app settings
`HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING`,
`HOT_UPDATER_AZURE_BLOB_CONTAINER` and
`HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING`, set with
`az functionapp config appsettings set`. Preserve unrelated app settings.
Record the verified `https://<defaultHostName>` in deployment.json.
