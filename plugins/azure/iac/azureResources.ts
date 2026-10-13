import fs from "fs/promises";
import os from "os";
import path from "path";

import { CosmosClient } from "@azure/cosmos";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { createZip, InitError } from "@hot-updater/cli-tools";

import {
  AZURE_BLOB_V1_CONTAINER,
  AZURE_COSMOS_V1_CONTAINER,
  AZURE_COSMOS_V1_DATABASE,
} from "../src/azureInfrastructureNames";
import {
  assertCosmosContainerReusable,
  currentCosmosEngine,
} from "../src/cosmosStore";
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
  readonly publicNetworkAccess?: string | null;
  readonly networkRuleSet?: { readonly defaultAction?: string } | null;
}

/** Account kinds with the Blob, Queue, and Table services a Function App's host storage needs. */
const FUNCTION_STORAGE_KINDS = new Set(["StorageV2", "Storage"]);

/**
 * Checks the storage account before init creates anything: an existing one
 * must be able to host the Function App and sign SAS URLs, and a new name
 * must be free. Resolves whether the account exists.
 */
export const assertStorageAccountCanInitialize = async ({
  az,
  name,
  resourceGroup,
}: {
  readonly az: AzureCli;
  readonly name: string;
  readonly resourceGroup: string;
}): Promise<boolean> => {
  const account = await showOrNull<StorageAccount>(az, [
    "storage",
    "account",
    "show",
    "--name",
    name,
    "--resource-group",
    resourceGroup,
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
    return false;
  }
  if (!FUNCTION_STORAGE_KINDS.has(account.kind ?? "")) {
    throw new InitError(
      `Storage account ${name} is a ${account.kind} account; the Function App's host storage needs a general-purpose (StorageV2) account with Blob, Queue, and Table services. Choose another name.`,
    );
  }
  if (account.allowSharedKeyAccess === false) {
    throw new InitError(
      `Storage account ${name} disallows shared key access, which the bundles' SAS URLs and the Function App's settings use. Allow it, or choose another account.`,
    );
  }
  if (
    account.publicNetworkAccess === "Disabled" ||
    account.networkRuleSet?.defaultAction === "Deny"
  ) {
    // Devices download bundles from it, and init sets up no virtual network
    // for the Function App's host storage.
    throw new InitError(
      `Storage account ${name} restricts network access, which devices downloading bundles and the Function App need. Choose another account.`,
    );
  }
  return true;
};

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
  if (!(await assertStorageAccountCanInitialize({ az, name, resourceGroup }))) {
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
  await ensurePrivateContainer(
    BlobServiceClient.fromConnectionString(
      connection.connectionString,
    ).getContainerClient(AZURE_BLOB_V1_CONTAINER),
  );
  return connection.connectionString;
};

/**
 * Creates the bundles' container, private, or makes a reused one private:
 * devices download bundles through SAS URLs, never anonymously. Its stored
 * access policies stay.
 */
export const ensurePrivateContainer = async (container: ContainerClient) => {
  if ((await container.createIfNotExists()).succeeded) return;
  const { blobPublicAccess, signedIdentifiers } =
    await container.getAccessPolicy();
  if (blobPublicAccess !== undefined) {
    await container.setAccessPolicy(undefined, signedIdentifiers);
  }
};

/** The Cosmos DB account's primary read-write connection string. */
const cosmosConnectionString = async (
  az: AzureCli,
  name: string,
  resourceGroup: string,
) => {
  const keys = await az<{
    connectionStrings?: readonly {
      connectionString: string;
      description?: string;
      keyKind?: string;
    }[];
  }>([
    "cosmosdb",
    "keys",
    "list",
    "--name",
    name,
    "--resource-group",
    resourceGroup,
    "--type",
    "connection-strings",
  ]);
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

/**
 * Checks, read only, the container init migrates in the account, from this
 * machine: a firewall that admits only Azure datacenters answers 403, and
 * an existing container must be one the migration may adopt.
 */
export const inspectCosmosAccount = async (connectionString: string) => {
  const client = new CosmosClient(connectionString);
  try {
    await assertCosmosContainerReusable(
      client
        .database(AZURE_COSMOS_V1_DATABASE)
        .container(AZURE_COSMOS_V1_CONTAINER),
      currentCosmosEngine(),
    );
  } finally {
    client.dispose();
  }
};

interface CosmosAccount {
  readonly kind?: string;
  readonly capabilities?: readonly { readonly name: string }[];
  readonly consistencyPolicy?: { readonly defaultConsistencyLevel?: string };
  readonly enableMultipleWriteLocations?: boolean;
  readonly disableLocalAuth?: boolean;
  readonly disableKeyBasedMetadataWriteAccess?: boolean;
  readonly publicNetworkAccess?: string | null;
  readonly ipRules?: readonly { readonly ipAddressOrRange?: string }[] | null;
  readonly isVirtualNetworkFilterEnabled?: boolean | null;
}

/**
 * Checks the Cosmos DB account before init creates anything: an existing one
 * must be an API for NoSQL account with strong consistency, which
 * `confirmStrong` may allow init to set, and a new name must be free.
 * Resolves whether init changes the account's consistency.
 */
export const assertCosmosAccountCanInitialize = async ({
  az,
  name,
  resourceGroup,
  confirmStrong,
  inspect = inspectCosmosAccount,
}: {
  readonly az: AzureCli;
  readonly name: string;
  readonly resourceGroup: string;
  readonly confirmStrong: () => Promise<boolean>;
  /** Checks the account's container from this machine; throws when init cannot use it. */
  readonly inspect?: (connectionString: string) => Promise<void>;
}): Promise<{ readonly exists: boolean; readonly strengthen: boolean }> => {
  const account = await showOrNull<CosmosAccount>(az, [
    "cosmosdb",
    "show",
    "--name",
    name,
    "--resource-group",
    resourceGroup,
  ]);
  if (account === null) {
    if (await az<boolean>(["cosmosdb", "check-name-exists", "--name", name])) {
      throw new InitError(
        `Cosmos DB account name ${name} is taken. Choose another name.`,
      );
    }
    return { exists: false, strengthen: false };
  }
  const otherApi = account.capabilities?.find(({ name: capability }) =>
    /^Enable(Mongo|Cassandra|Gremlin|Table)$/.test(capability),
  );
  if (account.kind !== "GlobalDocumentDB" || otherApi !== undefined) {
    throw new InitError(
      `Cosmos DB account ${name} is not an API for NoSQL account. Choose another name.`,
    );
  }
  // The Function App joins no virtual network: it reaches the account only
  // through public access open to Azure datacenters (the 0.0.0.0 rule).
  const datacenters = account.ipRules?.some(
    ({ ipAddressOrRange }) => ipAddressOrRange === "0.0.0.0",
  );
  if (
    account.publicNetworkAccess === "Disabled" ||
    ((account.ipRules?.length || account.isVirtualNetworkFilterEnabled) &&
      !datacenters)
  ) {
    throw new InitError(
      `Cosmos DB account ${name} restricts network access, which the Function App, outside any virtual network, cannot pass. Allow access from Azure datacenters, or choose another account.`,
    );
  }
  if (account.disableLocalAuth) {
    throw new InitError(
      `Cosmos DB account ${name} disables key authentication, which init and the Function App connect with. Allow it, or choose another account.`,
    );
  }
  if (account.disableKeyBasedMetadataWriteAccess) {
    // The migration creates the database and container and updates the
    // container's indexing policy with the account key.
    throw new InitError(
      `Cosmos DB account ${name} blocks database and container changes with its keys, which the migration makes. Allow them, or choose another account.`,
    );
  }
  // Init migrates the database from this machine, which a firewall that
  // admits only Azure datacenters blocks, into a container it must adopt.
  try {
    await inspect(await cosmosConnectionString(az, name, resourceGroup));
  } catch (error) {
    if (error instanceof InitError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new InitError(
      (error as { code?: unknown }).code === 403
        ? `Cosmos DB account ${name} refuses this machine, from which init migrates the database: ${message}. Add this machine's IP address to its firewall, or choose another account.`
        : message,
    );
  }
  if (account.consistencyPolicy?.defaultConsistencyLevel === "Strong") {
    return { exists: true, strengthen: false };
  }
  if (account.enableMultipleWriteLocations) {
    throw new InitError(
      `Cosmos DB account ${name} writes in several regions, which strong consistency does not allow. Choose another account.`,
    );
  }
  if (!(await confirmStrong())) {
    throw new InitError(
      `Cosmos DB account ${name} must use strong consistency. Choose another account, or allow init to change it.`,
    );
  }
  return { exists: true, strengthen: true };
};

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
  inspect,
}: {
  readonly az: AzureCli;
  readonly name: string;
  readonly resourceGroup: string;
  readonly location: string;
  /** Whether init may make an existing account's consistency strong. */
  readonly confirmStrong: () => Promise<boolean>;
  readonly inspect?: (connectionString: string) => Promise<void>;
}): Promise<string> => {
  const scope = ["--name", name, "--resource-group", resourceGroup];
  const { exists, strengthen } = await assertCosmosAccountCanInitialize({
    az,
    name,
    resourceGroup,
    confirmStrong,
    inspect,
  });
  if (!exists) {
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
      // The `EnableServerless` capability is refused by current API versions.
      "--capacity-mode",
      "Serverless",
      "--default-consistency-level",
      "Strong",
    ]);
  } else if (strengthen) {
    await az([
      "cosmosdb",
      "update",
      ...scope,
      "--default-consistency-level",
      "Strong",
    ]);
  }
  return cosmosConnectionString(az, name, resourceGroup);
};

interface FunctionApp {
  readonly defaultHostName?: string;
  readonly resourceGroup?: string;
  /** A Flex Consumption app's configuration, with its language runtime. */
  readonly functionAppConfig?: {
    readonly runtime?: { readonly name?: string; readonly version?: string };
  } | null;
}

/**
 * A Function App as `az functionapp show` reports it: a Flex Consumption
 * app keeps its fields under `properties`, other apps at the top.
 */
const siteOf = (
  raw: (FunctionApp & { readonly properties?: FunctionApp }) | null,
): FunctionApp | null => (raw === null ? null : { ...raw, ...raw.properties });

/** Whether `app` runs the Function init deploys: Flex Consumption, Node.js 22 or later. */
const runsFunction = (app: FunctionApp) => {
  const runtime = app.functionAppConfig?.runtime;
  return (
    runtime?.name?.toLowerCase() === "node" &&
    Number.parseInt(runtime.version ?? "", 10) >= Number(FUNCTION_NODE_VERSION)
  );
};

/**
 * Checks the Function App before init creates anything: an existing app in
 * the group must run the Function, and a new name must be free across
 * `azurewebsites.net`.
 */
export const assertFunctionAppCanInitialize = async ({
  az,
  subscriptionId,
  name,
  resourceGroup,
}: {
  readonly az: AzureCli;
  readonly subscriptionId: string;
  readonly name: string;
  readonly resourceGroup: string;
}) => {
  const app = siteOf(
    await showOrNull<FunctionApp>(az, [
      "functionapp",
      "show",
      "--name",
      name,
      "--resource-group",
      resourceGroup,
    ]),
  );
  if (app !== null) {
    assertRunsFunction(name, app);
    await assertHotUpdaterApp(az, name, resourceGroup);
    return;
  }
  const availability = await az<{
    nameAvailable?: boolean;
    message?: string;
  }>([
    "rest",
    "--method",
    "post",
    "--url",
    `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Web/checknameavailability?api-version=2024-04-01`,
    "--body",
    JSON.stringify({ name, type: "Microsoft.Web/sites" }),
  ]);
  if (availability?.nameAvailable === false) {
    throw new InitError(
      `Function App name ${name} is not available: ${availability.message ?? "it is taken"}. Choose another name.`,
    );
  }
};

/**
 * Refuses an existing app another project deploys to: deploying replaces its
 * whole package. Init's app carries the Function's settings; an app with no
 * functions yet, such as one an interrupted init created, is free to take.
 */
const assertHotUpdaterApp = async (
  az: AzureCli,
  name: string,
  resourceGroup: string,
) => {
  const scope = ["--name", name, "--resource-group", resourceGroup];
  const settings =
    (await az<{ name: string }[]>([
      "functionapp",
      "config",
      "appsettings",
      "list",
      ...scope,
    ])) ?? [];
  const ours = Object.values(FUNCTION_SETTINGS);
  if (settings.some((setting) => ours.includes(setting.name as never))) {
    return;
  }
  const functions =
    (await az<unknown[]>(["functionapp", "function", "list", ...scope])) ?? [];
  if (functions.length > 0) {
    throw new InitError(
      `Function App ${name} runs other functions and none of Hot Updater's settings; deploying would replace them. Choose another name.`,
    );
  }
};

const assertRunsFunction = (name: string, app: FunctionApp) => {
  if (!runsFunction(app)) {
    // Deploying would replace the package of an app on another stack.
    throw new InitError(
      `Function App ${name} is not a Flex Consumption app on Node.js ${FUNCTION_NODE_VERSION} or later. Choose another name, and init creates one.`,
    );
  }
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
  let app = siteOf(
    await showOrNull<FunctionApp>(az, ["functionapp", "show", ...scope]),
  );
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
    app =
      siteOf(await az<FunctionApp>(["functionapp", "show", ...scope])) ?? app;
  } else {
    assertRunsFunction(name, app);
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
