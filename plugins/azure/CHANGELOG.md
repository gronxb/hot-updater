# @hot-updater/azure

## 1.0.3

### Patch Changes

- Updated dependencies [407ec2c]
  - @hot-updater/cli-tools@1.0.3
  - @hot-updater/protocol@1.0.3
  - @hot-updater/server@1.0.3
  - @hot-updater/plugin-core@1.0.3

## 1.0.2

### Patch Changes

- ddfb139: Add the Azure provider, `@hot-updater/azure`: `azureBlobStorage` keeps bundles in Azure Blob Storage and serves them through SAS URLs, and `cosmosDatabase` runs Hot Updater's database in one Azure Cosmos DB for NoSQL container, with `migrateCosmosDatabase` to create it and write the schema settings. `hot-updater init` sets up Azure with the Azure CLI: it creates a storage account, a serverless Cosmos DB account with strong consistency, and a Flex Consumption Function App, migrates the database, deploys the Hot Updater Function, and creates the client API key. `hot-updater agent infra setup` and `hot-updater infra scaffold` take `--provider azure`.
- Updated dependencies [ddfb139]
- Updated dependencies [d4d1d07]
  - @hot-updater/cli-tools@1.0.2
  - @hot-updater/protocol@1.0.2
  - @hot-updater/server@1.0.2
  - @hot-updater/plugin-core@1.0.2
