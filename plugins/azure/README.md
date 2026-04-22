# @hot-updater/azure

Azure Blob Storage and Azure Functions plugin for [Hot Updater](https://github.com/gronxb/hot-updater).

Provides:

- **Storage plugin** (`azureBlobStorage`) — stores JS bundles and assets in Azure Blob Storage with SAS token URL generation.
- **Database plugin** (`azureBlobDatabase`) — stores bundle metadata as JSON files in Azure Blob Storage (same pattern as `@hot-updater/aws` S3 database).
- **Azure Functions handler** (`@hot-updater/azure/functions`) — bridges the Hot Updater server to Azure Functions v4 HTTP triggers.

## Installation

```bash
pnpm add @hot-updater/azure @azure/storage-blob
# Optional: for Azure Functions handler
pnpm add @azure/functions
```

## Configuration

### Environment Variables

Create a `.env.hotupdater` file:

```env
AZURE_STORAGE_ACCOUNT_NAME=your_storage_account
AZURE_STORAGE_ACCOUNT_KEY=your_storage_key
AZURE_STORAGE_CONTAINER_NAME=hot-updater-bundles
# Or use a connection string instead:
# AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...

# Optional: CDN domain for asset delivery
# AZURE_CDN_DOMAIN=https://cdn.example.com
```

### hot-updater.config.ts

```typescript
import { defineConfig } from "hot-updater";
import { azureBlobStorage, azureBlobDatabase } from "@hot-updater/azure";

export default defineConfig({
  build: metro(),
  storage: azureBlobStorage({
    accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME!,
    accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY!,
    containerName: process.env.AZURE_STORAGE_CONTAINER_NAME!,
    // cdnDomain: process.env.AZURE_CDN_DOMAIN,
  }),
  database: azureBlobDatabase({
    accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME!,
    accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY!,
    containerName: process.env.AZURE_STORAGE_CONTAINER_NAME!,
  }),
});
```

### Azure Functions Setup

```typescript
// src/functions/hotUpdater.ts
import { app } from "@azure/functions";
import { createHotUpdater } from "@hot-updater/server/runtime";
import {
  createAzureFunctionsHandler,
  azureBlobStorage,
  azureBlobDatabase,
} from "@hot-updater/azure/functions";

const hotUpdater = createHotUpdater({
  database: azureBlobDatabase({
    accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME!,
    accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY!,
    containerName: process.env.AZURE_STORAGE_CONTAINER_NAME!,
  }),
  storages: [
    azureBlobStorage({
      accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME!,
      accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY!,
      containerName: process.env.AZURE_STORAGE_CONTAINER_NAME!,
    }),
  ],
  basePath: "/api/hot-updater",
});

const handler = createAzureFunctionsHandler(hotUpdater);

app.http("hotUpdater", {
  methods: ["GET", "POST", "PATCH", "DELETE"],
  authLevel: "anonymous",
  route: "hot-updater/{*path}",
  handler,
});
```

## Storage Plugin

The `azureBlobStorage` plugin uses Azure Blob Storage to store JavaScript bundles and assets. It supports:

- **SAS token URL generation** for secure, time-limited access to blobs (requires `accountName`/`accountKey` auth).
- **CDN domain** — when `cdnDomain` is configured, `getDownloadUrl` returns a CDN URL instead of a SAS URL.
- **Custom SAS expiry** — configure `sasExpirySeconds` (default: 3600 seconds / 1 hour).

Storage URIs follow the format: `azure-blob://containerName/path/to/blob`.

## Database Plugin

The `azureBlobDatabase` plugin stores bundle metadata as JSON files in Azure Blob Storage, following the same blob-based approach as the S3 database plugin. This means no additional database infrastructure is needed.

## License

MIT
