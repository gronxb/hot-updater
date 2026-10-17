# @hot-updater/azure

## 1.1.0

### Patch Changes

- Updated dependencies [99d0356]
  - @hot-updater/protocol@1.1.0
  - @hot-updater/cli-tools@1.1.0
  - @hot-updater/server@1.1.0
  - @hot-updater/plugin-core@1.1.0

## 1.0.8

### Patch Changes

- @hot-updater/cli-tools@1.0.8
  - @hot-updater/protocol@1.0.8
  - @hot-updater/server@1.0.8
  - @hot-updater/plugin-core@1.0.8

## 1.0.7

### Patch Changes

- @hot-updater/cli-tools@1.0.7
  - @hot-updater/protocol@1.0.7
  - @hot-updater/server@1.0.7
  - @hot-updater/plugin-core@1.0.7

## 1.0.6

### Patch Changes

- Updated dependencies [5702bf5]
  - @hot-updater/plugin-core@1.0.6
  - @hot-updater/protocol@1.0.6
  - @hot-updater/server@1.0.6
  - @hot-updater/cli-tools@1.0.6

## 1.0.5

### Patch Changes

- @hot-updater/cli-tools@1.0.5
  - @hot-updater/protocol@1.0.5
  - @hot-updater/server@1.0.5
  - @hot-updater/plugin-core@1.0.5

## 1.0.4

### Patch Changes

- Updated dependencies [33bdc32]
  - @hot-updater/cli-tools@1.0.4
  - @hot-updater/protocol@1.0.4
  - @hot-updater/server@1.0.4
  - @hot-updater/plugin-core@1.0.4

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
