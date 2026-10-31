import { createHash } from "crypto";
import path from "path";

import {
  assembleServer,
  getCwd,
  getHotUpdaterInitInputEnv,
  getInitProviderEnvVars,
  getInitProviderTextPromptValues,
  InitError,
  link,
  makeEnv,
  p,
  printAppSetup,
  provisionClientCredential,
  type ProvisionedClientCredential,
  readHotUpdaterInitEnv,
  type RunInitOptions,
  shouldAutoSelectOnlyInitResource,
  writeHotUpdaterFiles,
} from "@hot-updater/cli-tools";
import { apiKeys, insights, remoteConfig } from "@hot-updater/server/plugins";

import { AZURE_BLOB_V1_CONTAINER } from "../src/azureInfrastructureNames";
import { cosmosDatabase, migrateCosmosDatabase } from "../src/cosmosDatabase";
import {
  type AzureSubscription,
  createAzureCli,
  describeSubscription,
  ensureResourceProviders,
  azureCliVersion,
  isAtLeastVersion,
  listFlexConsumptionLocations,
  listLocations,
  listSubscriptions,
  MIN_AZURE_CLI_VERSION,
  normalizeLocation,
} from "./azureCli";
import {
  assertCosmosAccountCanInitialize,
  assertFunctionAppCanInitialize,
  assertStorageAccountCanInitialize,
  createResourceGroup,
  deployFunction,
  ensureCosmosAccount,
  ensureFunctionApp,
  ensureStorageAccount,
  FUNCTION_SETTINGS,
  resolveResourceGroup,
  setFunctionSettings,
  verifyFunction,
} from "./azureResources";
import { getConfigScaffold } from "./configTemplate";
import {
  initProvider as AZURE_INIT_PROVIDER,
  isAzureCosmosAccountName,
  isAzureFunctionAppName,
  isAzureResourceGroupName,
  isAzureStorageAccountName,
} from "./init/index";

const inputs = AZURE_INIT_PROVIDER.inputs;

const exitIfCancelled = <T>(value: T | symbol): T => {
  if (p.isCancel(value)) process.exit(1);
  return value as T;
};

/**
 * Default resource names: a suffix from the subscription and resource
 * group, so a rerun proposes the same names and two projects do not collide
 * on the globally unique ones.
 */
export const defaultResourceNames = (
  subscriptionId: string,
  resourceGroup: string,
) => {
  const suffix = createHash("sha256")
    .update(`${subscriptionId}/${resourceGroup}`)
    .digest("hex")
    .slice(0, 8);
  return {
    storageAccount: `hotupdater${suffix}`,
    cosmosAccount: `hot-updater-${suffix}`,
    functionApp: `hot-updater-${suffix}`,
  };
};

const selectSubscription = async (
  subscriptions: readonly AzureSubscription[],
  savedId: string | undefined,
  nonInteractive: boolean,
) => {
  const saved = subscriptions.find(
    (subscription) => subscription.id === savedId,
  );
  if (nonInteractive) {
    if (saved) return saved.id;
    throw new InitError(
      savedId
        ? `Subscription ${savedId} is not one the Azure CLI's account can use.`
        : `${inputs.subscriptionId.envKey} is required.`,
    );
  }
  if (savedId && !saved) {
    p.log.warn("The saved Azure subscription was not found. Select one again.");
  }
  if (
    shouldAutoSelectOnlyInitResource({
      availableResourceCount: subscriptions.length,
      savedIdentifier: saved?.id,
    })
  ) {
    return subscriptions[0]!.id;
  }
  return exitIfCancelled(
    await p.select({
      message: inputs.subscriptionId.prompt.message,
      initialValue:
        saved?.id ??
        subscriptions.find((subscription) => subscription.isDefault)?.id ??
        subscriptions[0]?.id,
      options: subscriptions.map((subscription) => ({
        value: subscription.id,
        label: subscription.name,
        hint: describeSubscription(subscription),
      })),
    }),
  );
};

/** A text input: the saved value without asking when non-interactive, else a prompt defaulting to it. */
const resolveName = async ({
  input,
  saved,
  fallback,
  nonInteractive,
  validate,
  hint,
}: {
  readonly input: {
    readonly envKey: string;
    readonly prompt: {
      readonly message: string;
      readonly defaultValue?: string;
    };
  };
  readonly saved: string | undefined;
  readonly fallback: string;
  readonly nonInteractive: boolean;
  readonly validate: (value: string | undefined) => boolean;
  readonly hint: string;
}) => {
  if (nonInteractive) {
    const value = saved ?? fallback;
    if (!validate(value)) throw new InitError(`${input.envKey}: ${hint}`);
    return value;
  }
  return exitIfCancelled(
    await p.text({
      ...getInitProviderTextPromptValues(
        { ...input.prompt, type: "text", defaultValue: fallback },
        saved,
      ),
      message: input.prompt.message,
      validate: (value) => (validate(value) ? undefined : hint),
    }),
  );
};

export const runInit = async ({
  build,
  envFile,
  secretsEnv,
}: RunInitOptions) => {
  const cwd = getCwd();
  const nonInteractive = envFile !== undefined;
  const initEnvSources = await readHotUpdaterInitEnv(cwd, envFile, secretsEnv);
  const initInputEnv = getHotUpdaterInitInputEnv(
    initEnvSources,
    nonInteractive,
  );
  const saved = Object.fromEntries(
    Object.entries(inputs).map(([name, input]) => [
      name,
      initInputEnv[input.envKey]?.trim() || undefined,
    ]),
  ) as Partial<Record<keyof typeof inputs, string>>;

  const cliVersion = await azureCliVersion();
  if (cliVersion === null) {
    p.log.error("The Azure CLI (az) is not installed.");
    p.log.step(link("https://learn.microsoft.com/cli/azure/install-azure-cli"));
    process.exit(1);
  }
  if (!isAtLeastVersion(cliVersion, MIN_AZURE_CLI_VERSION)) {
    throw new InitError(
      `Azure CLI ${cliVersion} has no Flex Consumption commands; upgrade it to ${MIN_AZURE_CLI_VERSION} or later (az upgrade).`,
    );
  }

  const subscriptions = await listSubscriptions(nonInteractive);
  const subscriptionId = await selectSubscription(
    subscriptions,
    saved.subscriptionId,
    nonInteractive,
  );
  const subscription = subscriptions.find(({ id }) => id === subscriptionId)!;
  p.log.info(
    `Using subscription ${subscription.name} (${describeSubscription(subscription)})`,
  );
  const az = createAzureCli(subscriptionId);
  await p.tasks([
    {
      title: "Registering the Azure resource providers...",
      task: async () => {
        await ensureResourceProviders(az);
        return "Storage, Cosmos DB, Functions, and Container Apps providers are registered";
      },
    },
  ]);

  const resourceGroup = await resolveName({
    input: inputs.resourceGroup,
    saved: saved.resourceGroup,
    fallback: inputs.resourceGroup.prompt.defaultValue,
    nonInteractive,
    validate: isAzureResourceGroupName,
    hint: "Use up to 90 letters, digits, '.', '_', '-', '(' or ')', not ending in '.'.",
  });
  const { location, exists: groupExists } = await resolveResourceGroup(
    az,
    resourceGroup,
    async () => {
      const locations = await listLocations(az, subscriptionId);
      const savedLocation = locations.find(
        ({ name }) => name === saved.location,
      );
      if (nonInteractive) {
        if (savedLocation) return savedLocation.name;
        throw new InitError(
          `${inputs.location.envKey} is required to create resource group ${resourceGroup}.`,
        );
      }
      return exitIfCancelled(
        await p.select({
          message: inputs.location.prompt.message,
          initialValue:
            savedLocation?.name ??
            locations.find(({ name }) => name === "eastus")?.name ??
            locations[0]?.name,
          options: locations.map(({ name, displayName }) => ({
            value: name,
            label: `${displayName} (${name})`,
          })),
        }),
      );
    },
  );
  // The Function App shares the group's region; check it before creating
  // anything there.
  if (
    !(await listFlexConsumptionLocations(az)).has(normalizeLocation(location))
  ) {
    throw new InitError(
      `Resource group ${resourceGroup} is in ${location}, which has no Flex Consumption Function Apps. Choose another resource group, or a new one in a supported region (az functionapp list-flexconsumption-locations).`,
    );
  }

  const defaults = defaultResourceNames(subscriptionId, resourceGroup);
  const storageAccount = await resolveName({
    input: { ...inputs.storageAccount, prompt: inputs.storageAccount.prompt },
    saved: saved.storageAccount,
    fallback: defaults.storageAccount,
    nonInteractive,
    validate: isAzureStorageAccountName,
    hint: "Use 3 to 24 lowercase letters and digits.",
  });
  const cosmosAccount = await resolveName({
    input: inputs.cosmosAccount,
    saved: saved.cosmosAccount,
    fallback: defaults.cosmosAccount,
    nonInteractive,
    validate: isAzureCosmosAccountName,
    hint: "Use 3 to 44 lowercase letters, digits, and inner '-'.",
  });
  const functionApp = await resolveName({
    input: inputs.functionApp,
    saved: saved.functionApp,
    fallback: defaults.functionApp,
    nonInteractive,
    validate: isAzureFunctionAppName,
    hint: "Use 2 to 60 letters, digits, and inner '-'.",
  });

  // Every check before any resource exists: a refusal after one is created
  // would leave it behind.
  await assertFunctionAppCanInitialize({
    az,
    subscriptionId,
    name: functionApp,
    resourceGroup,
  });
  await assertStorageAccountCanInitialize({
    az,
    name: storageAccount,
    resourceGroup,
  });
  // Last: with approval, it makes an existing account's consistency strong,
  // which Azure may refuse, so it changes nothing until the rest passed.
  await assertCosmosAccountCanInitialize({
    az,
    name: cosmosAccount,
    resourceGroup,
    confirmStrong: async () =>
      !nonInteractive &&
      exitIfCancelled(
        await p.confirm({
          message: `Change Cosmos DB account ${cosmosAccount} to strong consistency? Other apps on it read under it too.`,
          initialValue: false,
        }),
      ),
  });
  if (!groupExists) await createResourceGroup(az, resourceGroup, location);
  p.log.info(
    `${groupExists ? "Using" : "Created"} resource group ${resourceGroup} in ${location}`,
  );

  let storageConnectionString = "";
  let cosmosConnectionString = "";
  await p.tasks([
    {
      title: `Preparing storage account ${storageAccount}...`,
      task: async () => {
        storageConnectionString = await ensureStorageAccount({
          az,
          name: storageAccount,
          resourceGroup,
          location,
        });
        return `Storage account ${storageAccount} is ready`;
      },
    },
  ]);
  // A new account takes several minutes.
  const spinner = p.spinner();
  spinner.start(`Preparing Cosmos DB account ${cosmosAccount}...`);
  try {
    cosmosConnectionString = await ensureCosmosAccount({
      az,
      name: cosmosAccount,
      resourceGroup,
      location,
      // The preflight made an approved account strong already.
      confirmStrong: async () => false,
    });
    spinner.stop(`Cosmos DB account ${cosmosAccount} is ready`);
  } catch (error) {
    spinner.error(`Cosmos DB account ${cosmosAccount} is not ready`);
    throw error;
  }

  const resolvedInputs = {
    subscriptionId,
    resourceGroup,
    location,
    storageAccount,
    cosmosAccount,
    functionApp,
    storageConnectionString,
    cosmosConnectionString,
  };
  // The connection strings too: hot-updater.config.ts reads them, and init
  // reads them from Azure again on every run.
  await makeEnv(
    getInitProviderEnvVars({
      includeConsentInputs: true,
      inputs: resolvedInputs,
      provider: AZURE_INIT_PROVIDER,
    }),
  );

  const plugins = [insights(), apiKeys(), remoteConfig()];
  let baseURL = "";
  await p.tasks([
    {
      title: "Migrating the Cosmos DB database...",
      task: async () => {
        await migrateCosmosDatabase(
          { connectionString: cosmosConnectionString },
          plugins,
        );
        return "Migrated the Cosmos DB database";
      },
    },
    {
      title: `Preparing Function App ${functionApp}...`,
      task: async () => {
        baseURL = await ensureFunctionApp({
          az,
          name: functionApp,
          resourceGroup,
          location,
          storageAccount,
        });
        await setFunctionSettings({
          az,
          name: functionApp,
          resourceGroup,
          settings: {
            [FUNCTION_SETTINGS.storageConnectionString]:
              storageConnectionString,
            [FUNCTION_SETTINGS.blobContainer]: AZURE_BLOB_V1_CONTAINER,
            [FUNCTION_SETTINGS.cosmosConnectionString]: cosmosConnectionString,
          },
        });
        return `Function App ${functionApp} is ready`;
      },
    },
    {
      title: "Deploying the Hot Updater Function...",
      task: async () => {
        await deployFunction({
          az,
          functionDir: path.join(
            path.dirname(require.resolve("@hot-updater/azure/package.json")),
            "dist/functions",
          ),
          name: functionApp,
          resourceGroup,
        });
        await verifyFunction(baseURL);
        return `Deployed the Hot Updater Function: ${baseURL}`;
      },
    },
  ]);

  const database = cosmosDatabase({ connectionString: cosmosConnectionString });
  // The managed server: its plugins over the database init set up, which
  // assembling it neither reads nor writes.
  const server = assembleServer({ database, plugins });
  let credential: ProvisionedClientCredential | undefined;
  try {
    credential = await provisionClientCredential(server, {
      env: initInputEnv,
      name: "Azure init",
    });
    if (credential !== undefined) {
      await makeEnv({ [credential.env]: credential.value });
    }
  } finally {
    await database.dispose?.();
  }

  p.log.success("Generated '.env.hotupdater' file with Azure settings.");
  const cosmosEndpoint = /AccountEndpoint=([^;]+)/iu.exec(
    cosmosConnectionString,
  )?.[1];
  await writeHotUpdaterFiles(
    getConfigScaffold(
      build,
      cosmosEndpoint === undefined ? {} : { cosmosEndpoint },
    ),
    {
      cwd,
      settings: "Azure",
    },
  );

  printAppSetup({
    baseURL,
    ...(credential === undefined ? {} : { credential }),
    clientPlugins: server.clientPlugins,
  });
  p.log.message(
    `Next step: ${link(
      "https://hot-updater.dev/docs/managed/azure#step-3-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};

// The Function package the infrastructure scaffold ships.
export { AZURE_FUNCTION_PACKAGE } from "./azureResources";

// What init asks for and checks before `runInit`.
export { initProvider } from "./init/index";
