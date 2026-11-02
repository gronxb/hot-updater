import type { InitProviderDefinition } from "@hot-updater/cli-tools";

/**
 * A resource group name: 1 to 90 letters, digits, `_`, `-`, `.`, `(`, and
 * `)`, Unicode letters and digits included, not ending in `.`.
 */
export const isAzureResourceGroupName = (value: string | undefined) =>
  value !== undefined &&
  /^[\p{L}\p{N}_\-.()]{0,89}[\p{L}\p{N}_\-()]$/u.test(value);

/** A storage account name: 3 to 24 lowercase letters and digits. */
export const isAzureStorageAccountName = (value: string | undefined) =>
  value !== undefined && /^[a-z0-9]{3,24}$/.test(value);

/** A Cosmos DB account name: 3 to 44 lowercase letters, digits, and inner `-`. */
export const isAzureCosmosAccountName = (value: string | undefined) =>
  value !== undefined && /^[a-z0-9](?:[a-z0-9-]{1,42})[a-z0-9]$/.test(value);

/** A Function App name: 2 to 60 letters, digits, and inner `-`. */
export const isAzureFunctionAppName = (value: string | undefined) =>
  value !== undefined &&
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,58})[A-Za-z0-9]$/.test(value);

export const initProvider = {
  label: "Azure Blob Storage + Functions + Cosmos DB",
  inputs: {
    subscriptionId: {
      envKey: "HOT_UPDATER_AZURE_SUBSCRIPTION_ID",
      help: "Azure subscription ID that holds the resources",
      prompt: {
        message: "Select an Azure subscription",
        type: "select",
      },
    },
    resourceGroup: {
      envKey: "HOT_UPDATER_AZURE_RESOURCE_GROUP",
      help: "Resource group that holds the Hot Updater resources",
      prompt: {
        defaultValue: "hot-updater",
        message: "Enter the resource group name",
        placeholder: "hot-updater",
        type: "text",
      },
      validate: isAzureResourceGroupName,
    },
    location: {
      envKey: "HOT_UPDATER_AZURE_LOCATION",
      help: "Azure region of a new resource group, such as eastus",
      optional: true,
      prompt: {
        message: "Select the region for the new resource group",
        type: "select",
      },
    },
    storageAccount: {
      envKey: "HOT_UPDATER_AZURE_STORAGE_ACCOUNT",
      help: "Storage account that keeps the bundles and runs the Function App",
      prompt: {
        message: "Enter the storage account name",
        type: "text",
      },
      validate: isAzureStorageAccountName,
    },
    cosmosAccount: {
      envKey: "HOT_UPDATER_AZURE_COSMOS_ACCOUNT",
      help: "Cosmos DB for NoSQL account of the Hot Updater database",
      prompt: {
        message: "Enter the Cosmos DB account name",
        type: "text",
      },
      validate: isAzureCosmosAccountName,
    },
    functionApp: {
      envKey: "HOT_UPDATER_AZURE_FUNCTION_APP",
      help: "Function App that runs the Hot Updater server",
      prompt: {
        message: "Enter the Function App name",
        type: "text",
      },
      validate: isAzureFunctionAppName,
    },
    storageConnectionString: {
      envKey: "HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING",
      help: "The storage account's connection string, which init reads from Azure and saves for hot-updater.config.ts",
      optional: true,
      preflight: false,
    },
    cosmosConnectionString: {
      envKey: "HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING",
      help: "The Cosmos DB account's connection string, which init reads from Azure and saves for hot-updater.config.ts",
      optional: true,
      preflight: false,
    },
  },
  secrets: [
    "HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING",
    "HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING",
  ],
} as const satisfies InitProviderDefinition;
