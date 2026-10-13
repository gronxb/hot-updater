import fs from "fs/promises";
import os from "os";
import path from "path";

import { BlobServiceClient } from "@azure/storage-blob";
import { createZip, InitError } from "@hot-updater/cli-tools";

import { AZURE_BLOB_V1_CONTAINER } from "../src/azureInfrastructureNames";
import { type AzureCli, showOrNull } from "./azureCli";

/** The Function App settings the deployed function reads. */
export const FUNCTION_SETTINGS = {
  storageConnectionString: "HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING",
  blobContainer: "HOT_UPDATER_AZURE_BLOB_CONTAINER",
  cosmosConnectionString: "HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING",
} as const;

/** The `package.json` of the zip package: it points the Functions host at the bundled `index.mjs`. */
export const AZURE_FUNCTION_PACKAGE = {
  name: "hot-updater-azure-function",
  private: true,
  type: "module",
  main: "index.mjs",
} as const;

/** The Node.js version of the Function App init creates. */
export const FUNCTION_NODE_VERSION = "22";

interface ResourceGroup {
  readonly location: string;
}

/** The group's region; init creates the group in `location` when it is missing. */
export const ensureResourceGroup = async (
  az: AzureCli,
  name: string,
  location: () => Promise<string>,
): Promise<{ readonly location: string; readonly created: boolean }> => {
  const group = await showOrNull<ResourceGroup>(az, [
    "group",
    "show",
    "--name",
    name,
  ]);
  if (group !== null) return { location: group.location, created: false };
  const region = await location();
  await az(["group", "create", "--name", name, "--location", region]);
  return { location: region, created: true };
};

interface StorageAccount {
  readonly kind?: string;
  readonly allowSharedKeyAccess?: boolean | null;
}

/** Account kinds with the Blob, Queue, and Table services a Function App's host storage needs. */
const FUNCTION_STORAGE_KINDS = new Set(["StorageV2", "Storage"]);

/** The storage account's connection string, with the bundles' container in it. */
export const ensureStorageAccount = async ({
  az,
  name,
  resourceGroup,
  location,
}: {
  readonly az: AzureCli;
  readonly name: string;
  readonly resourceGroup: string;
  readonly location: string;
}): Promise<string> => {
  const scope = ["--name", name, "--resource-group", resourceGroup];
  const account = await showOrNull<StorageAccount>(az, [
    "storage",
    "account",
    "show",
    ...scope,
  ]);
  if (account === null) {
    const check = await az<{ nameAvailable: boolean; message?: string }>([
      "storage",
      "account",
      "check-name",
      "--name",
      name,
    ]);
    if (check?.nameAvailable === false) {
      throw new InitError(
        `Storage account name ${name} is not available: ${check.message ?? "it is taken"}. Choose another name.`,
      );
    }
    await az([
      "storage",
      "account",
      "create",
      ...scope,
      "--location",
      location,
      "--sku",
      "Standard_LRS",
      "--kind",
      "StorageV2",
      "--min-tls-version",
      "TLS1_2",
      "--allow-blob-public-access",
      "false",
    ]);
  } else if (!FUNCTION_STORAGE_KINDS.has(account.kind ?? "")) {
    throw new InitError(
      `Storage account ${name} is a ${account.kind} account; the Function App's host storage needs a general-purpose (StorageV2) account with Blob, Queue, and Table services. Choose another name.`,
    );
  } else if (account.allowSharedKeyAccess === false) {
    throw new InitError(
      `Storage account ${name} disallows shared key access, which the bundles' SAS URLs and the Function App's settings use. Allow it, or choose another account.`,
    );
  }
  const connection = await az<{ connectionString: string }>([
    "storage",
    "account",
    "show-connection-string",
    ...scope,
  ]);
  if (!connection?.connectionString) {
    throw new InitError(
      `Storage account ${name} returned no connection string.`,
    );
  }
  await BlobServiceClient.fromConnectionString(connection.connectionString)
    .getContainerClient(AZURE_BLOB_V1_CONTAINER)
    .createIfNotExists();
  return connection.connectionString;
};

interface CosmosAccount {
  readonly kind?: string;
  readonly capabilities?: readonly { readonly name: string }[];
  readonly consistencyPolicy?: { readonly defaultConsistencyLevel?: string };
}

/**
 * The Cosmos DB account's connection string. A new account is serverless
 * with strong consistency, which the database's guarded writes read under;
 * an account of another API is refused.
 */
export const ensureCosmosAccount = async ({
  az,
  name,
  resourceGroup,
  location,
  confirmStrong,
}: {
  readonly az: AzureCli;
  readonly name: string;
  readonly resourceGroup: string;
  readonly location: string;
  /** Whether init may make an existing account's consistency strong. */
  readonly confirmStrong: () => Promise<boolean>;
}): Promise<string> => {
  const scope = ["--name", name, "--resource-group", resourceGroup];
  const account = await showOrNull<CosmosAccount>(az, [
    "cosmosdb",
    "show",
    ...scope,
  ]);
  if (account === null) {
    if (await az<boolean>(["cosmosdb", "check-name-exists", "--name", name])) {
      throw new InitError(
        `Cosmos DB account name ${name} is taken. Choose another name.`,
      );
    }
    await az([
      "cosmosdb",
      "create",
      ...scope,
      "--kind",
      "GlobalDocumentDB",
      "--locations",
      `regionName=${location}`,
      "failoverPriority=0",
      "isZoneRedundant=False",
      "--capabilities",
      "EnableServerless",
      "--default-consistency-level",
      "Strong",
    ]);
  } else {
    const otherApi = account.capabilities?.find(({ name: capability }) =>
      /^Enable(Mongo|Cassandra|Gremlin|Table)$/.test(capability),
    );
    if (account.kind !== "GlobalDocumentDB" || otherApi !== undefined) {
      throw new InitError(
        `Cosmos DB account ${name} is not an API for NoSQL account. Choose another name.`,
      );
    }
    if (account.consistencyPolicy?.defaultConsistencyLevel !== "Strong") {
      if (!(await confirmStrong())) {
        throw new InitError(
          `Cosmos DB account ${name} must use strong consistency. Choose another account, or allow init to change it.`,
        );
      }
      await az([
        "cosmosdb",
        "update",
        ...scope,
        "--default-consistency-level",
        "Strong",
      ]);
    }
  }
  const keys = await az<{
    connectionStrings?: readonly {
      connectionString: string;
      description?: string;
      keyKind?: string;
    }[];
  }>(["cosmosdb", "keys", "list", ...scope, "--type", "connection-strings"]);
  const primary =
    keys?.connectionStrings?.find(
      ({ description, keyKind }) =>
        keyKind === "Primary" ||
        description === "Primary SQL Connection String",
    ) ?? keys?.connectionStrings?.[0];
  if (!primary?.connectionString) {
    throw new InitError(
      `Cosmos DB account ${name} returned no connection string.`,
    );
  }
  return primary.connectionString;
};

interface FunctionApp {
  readonly defaultHostName?: string;
  readonly resourceGroup?: string;
  /** A Flex Consumption app's configuration, with its language runtime. */
  readonly functionAppConfig?: {
    readonly runtime?: { readonly name?: string; readonly version?: string };
  } | null;
}

/** Whether `app` runs the Function init deploys: Flex Consumption, Node.js 22 or later. */
const runsFunction = (app: FunctionApp) => {
  const runtime = app.functionAppConfig?.runtime;
  return (
    runtime?.name?.toLowerCase() === "node" &&
    Number.parseInt(runtime.version ?? "", 10) >= Number(FUNCTION_NODE_VERSION)
  );
};

/** The Function App's base URL, creating it on a Flex Consumption plan when it is missing. */
export const ensureFunctionApp = async ({
  az,
  name,
  resourceGroup,
  location,
  storageAccount,
}: {
  readonly az: AzureCli;
  readonly name: string;
  readonly resourceGroup: string;
  readonly location: string;
  readonly storageAccount: string;
}): Promise<string> => {
  const scope = ["--name", name, "--resource-group", resourceGroup];
  let app = await showOrNull<FunctionApp>(az, [
    "functionapp",
    "show",
    ...scope,
  ]);
  if (app === null) {
    app = await az<FunctionApp>([
      "functionapp",
      "create",
      ...scope,
      "--storage-account",
      storageAccount,
      "--flexconsumption-location",
      location,
      "--runtime",
      "node",
      "--runtime-version",
      FUNCTION_NODE_VERSION,
    ]);
    app = (await az<FunctionApp>(["functionapp", "show", ...scope])) ?? app;
  } else if (!runsFunction(app)) {
    // Deploying would replace the package of an app on another stack.
    throw new InitError(
      `Function App ${name} is not a Flex Consumption app on Node.js ${FUNCTION_NODE_VERSION} or later. Choose another name, and init creates one.`,
    );
  }
  if (!app?.defaultHostName) {
    throw new InitError(`Function App ${name} reported no host name.`);
  }
  return `https://${app.defaultHostName}`;
};

/** Sets the Function App's settings the deployed function reads. */
export const setFunctionSettings = async ({
  az,
  name,
  resourceGroup,
  settings,
}: {
  readonly az: AzureCli;
  readonly name: string;
  readonly resourceGroup: string;
  readonly settings: Readonly<Record<string, string>>;
}) => {
  await az([
    "functionapp",
    "config",
    "appsettings",
    "set",
    "--name",
    name,
    "--resource-group",
    resourceGroup,
    "--settings",
    ...Object.entries(settings).map(([key, value]) => `${key}=${value}`),
  ]);
};

/**
 * Deploys the bundled function: `index.mjs`, `host.json`, and the
 * `package.json` that points the Functions host at it, zipped.
 */
export const deployFunction = async ({
  az,
  functionDir,
  name,
  resourceGroup,
}: {
  readonly az: AzureCli;
  /** The package's `dist/functions`, which holds `index.mjs` and `host.json`. */
  readonly functionDir: string;
  readonly name: string;
  readonly resourceGroup: string;
}) => {
  const workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-azure-"),
  );
  try {
    const appDir = path.join(workDir, "app");
    await fs.mkdir(appDir);
    for (const file of ["index.mjs", "host.json"]) {
      await fs.copyFile(path.join(functionDir, file), path.join(appDir, file));
    }
    await fs.writeFile(
      path.join(appDir, "package.json"),
      `${JSON.stringify(AZURE_FUNCTION_PACKAGE, null, 2)}\n`,
    );
    const zip = path.join(workDir, "function.zip");
    await createZip({ outfile: zip, targetDir: appDir });
    await az([
      "functionapp",
      "deployment",
      "source",
      "config-zip",
      "--name",
      name,
      "--resource-group",
      resourceGroup,
      "--src",
      zip,
    ]);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
};

/** Waits until the deployed server answers its version route. */
export const verifyFunction = async (
  baseURL: string,
  { attempts = 60, delayMs = 5_000 } = {},
) => {
  let last = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseURL}/version`);
      if (response.ok) return;
      last = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new InitError(
    `The Hot Updater Function at ${baseURL} did not answer /version (${last}). Check the Function App's logs in the Azure portal.`,
  );
};
