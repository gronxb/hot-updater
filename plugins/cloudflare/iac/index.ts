import crypto from "crypto";
import path from "path";

import {
  clientAuthOf,
  confirmInitInputPersistence,
  copyDirToTmp,
  getHotUpdaterInitInputEnv,
  getInitProviderEnvVars,
  getInitProviderTextPromptValues,
  getCwd,
  link,
  loadManagedServerDefinition,
  makeEnv,
  managedServerDefinitionOf,
  p,
  printAppSetup,
  provisionClientCredential,
  type ProvisionedClientCredential,
  readHotUpdaterInitEnv,
  type RunInitOptions,
  readManagedServerDefinition,
  replacingServerDefinitions,
  writeHotUpdaterFiles,
} from "@hot-updater/cli-tools";
import { createHotUpdater } from "@hot-updater/server";
import { Cloudflare } from "cloudflare";

import { d1Database } from "../src/d1Database";
import { plugins } from "../src/plugins";
import { createWrangler } from "../src/utils/createWrangler";
import {
  validateCloudflareApiToken,
  verifyCloudflareApiTokenIdentity,
} from "./cloudflareApiToken";
import { resolveCloudflareReplayD1Database } from "./cloudflareD1Selection";
import { resolveCloudflareInfrastructureApiToken } from "./cloudflareInfrastructureAuth";
import {
  assertCloudflareInfrastructureCanInitialize,
  assertCloudflareWorkerCanInitialize,
} from "./cloudflareInfrastructureState";
import {
  CLOUDFLARE_INIT_PERMISSION,
  type CloudflareCredentialSource,
  runCloudflareApiRequest,
  toCloudflareApiError,
  toCloudflareDeploymentError,
} from "./cloudflareInitErrors";
import {
  assertCloudflareNonInteractiveInputs,
  resolveR2Privacy,
  resolveCloudflareInitInputs,
  shouldUpdateR2ManagedDomain,
} from "./cloudflareInitInputs";
import { inputCloudflareInitSecrets } from "./cloudflareInitSecrets";
import { getConfigScaffold } from "./configTemplate";
import { initProvider as CLOUDFLARE_INIT_PROVIDER } from "./init/index";
import {
  buildWorkerFromDefinition,
  prepareWorkerDeployment,
} from "./managedWorker";

/** The Worker's code, staged in the project's `.hot-updater` directory. */
interface StagedWorker {
  readonly workerRoot: string;
  /** The entry wrangler deploys when it is not the prebuilt Worker's. */
  readonly main: string | undefined;
  readonly remove: () => Promise<void>;
}

/**
 * Stages the Worker's code: the prebuilt Worker, and the project's server
 * definition bundled with the Worker's runtime module when the project
 * edited it. A definition that cannot be bundled fails here, before init
 * changes any resource.
 */
const stageWorker = async (
  definition: string | undefined,
): Promise<StagedWorker> => {
  const cwd = getCwd();
  const packageRoot = path.dirname(
    require.resolve("@hot-updater/cloudflare/package.json", { paths: [cwd] }),
  );
  const { tmpDir, removeTmpDir } = await copyDirToTmp(packageRoot);
  const workerRoot = path.join(tmpDir, "worker");
  try {
    const main =
      definition === undefined
        ? undefined
        : await buildWorkerFromDefinition({
            definition,
            packageRoot,
            projectRoot: cwd,
            workerRoot,
          });
    return { workerRoot, main, remove: removeTmpDir };
  } catch (error) {
    await removeTmpDir();
    throw error;
  }
};

const deployWorker = async (
  apiToken: string,
  accountId: string,
  {
    credentialSource,
    d1DatabaseId,
    d1DatabaseName,
    nonInteractive,
    plugins: serverPlugins,
    r2BucketName,
    staged,
    workerName,
  }: {
    credentialSource: CloudflareCredentialSource;
    d1DatabaseId: string;
    d1DatabaseName: string;
    nonInteractive: boolean;
    /** The plugins the Worker runs, whose tables the migration creates. */
    plugins: readonly unknown[];
    r2BucketName: string;
    /** From `stageWorker`. */
    staged: StagedWorker;
    workerName: string;
  },
) => {
  const { workerRoot } = staged;

  try {
    await prepareWorkerDeployment(workerRoot, {
      d1DatabaseId,
      d1DatabaseName,
      main: staged.main,
      plugins: serverPlugins,
      r2BucketName,
    });

    const wrangler = await createWrangler({
      stdio: "inherit",
      cloudflareApiToken: apiToken,
      cwd: workerRoot,
      accountId: accountId,
      nonInteractive,
    });

    await wrangler("d1", "migrations", "apply", d1DatabaseName, "--remote");

    await wrangler("deploy", "--name", workerName);
    const secretWrangler = createWrangler({
      stdio: "pipe",
      cloudflareApiToken: apiToken,
      cwd: workerRoot,
      accountId,
      nonInteractive,
    });
    const secretCommand = secretWrangler(
      "secret",
      "put",
      "STORAGE_DOWNLOAD_URL_SIGNING_KEY",
      "--name",
      workerName,
    );
    if (!secretCommand.stdin) {
      throw new Error("Failed to open Wrangler secret input.");
    }
    secretCommand.stdin.end(crypto.randomBytes(32).toString("hex"));
    await secretCommand;
    return workerName;
  } catch (error) {
    if (error instanceof Error) {
      throw toCloudflareDeploymentError(error, credentialSource);
    }
    throw new Error(String(error));
  }
};

export const runInit = async ({
  build,
  envFile,
  otherServerDefinitions,
}: RunInitOptions) => {
  const cwd = getCwd();
  const scaffold = replacingServerDefinitions(
    getConfigScaffold(build),
    otherServerDefinitions,
  );
  const definition = await readManagedServerDefinition(scaffold, cwd);
  const nonInteractive = envFile !== undefined;
  const initEnvSources = await readHotUpdaterInitEnv(cwd, envFile);
  const { managedEnv } = initEnvSources;
  const initInputEnv = getHotUpdaterInitInputEnv(
    initEnvSources,
    nonInteractive,
  );
  const existingInputs = resolveCloudflareInitInputs(initInputEnv);
  assertCloudflareNonInteractiveInputs(existingInputs, nonInteractive);
  const {
    accessKeyId: existingR2AccessKeyId,
    accountId: existingAccountId,
    apiToken: existingApiToken,
    bucketName: existingBucketName,
    d1DatabaseId: existingD1DatabaseId,
    d1DatabaseName: existingD1DatabaseName,
    r2Private: savedPrivateSetting,
    secretAccessKey: existingR2SecretAccessKey,
    workerName: existingWorkerName,
  } = existingInputs;

  const infrastructureCredentialSource: CloudflareCredentialSource = {
    kind: "wrangler-oauth",
  };
  const infrastructureApiToken = await resolveCloudflareInfrastructureApiToken({
    cwd,
    nonInteractive,
  });

  const cf = new Cloudflare({
    apiToken: infrastructureApiToken,
  });

  const createKey = `create/${Math.random().toString(36).substring(2, 15)}`;

  let accountId: string;
  if (nonInteractive && existingAccountId) {
    accountId = existingAccountId;
    p.log.info("Using existing Cloudflare account ID.");
  } else {
    const accounts: { id: string; name: string }[] = [];

    try {
      await p.tasks([
        {
          title: "Checking Account List...",
          task: async () => {
            accounts.push(
              ...(await cf.accounts.list()).result.map((account) => ({
                id: account.id,
                name: account.name,
              })),
            );
          },
        },
      ]);
    } catch (error) {
      if (error instanceof Error) {
        throw toCloudflareApiError(error, infrastructureCredentialSource);
      }
      throw new Error(String(error));
    }

    const savedAccount = accounts.find(
      (account) => account.id === existingAccountId,
    );
    if (existingAccountId && !savedAccount) {
      p.log.warn(
        "Saved Cloudflare account was not found. Select an account again.",
      );
    }
    const selectedAccountId = await p.select({
      initialValue: savedAccount?.id ?? accounts[0]?.id,
      message: CLOUDFLARE_INIT_PROVIDER.inputs.accountId.prompt.message,
      options: accounts.map((account) => ({
        value: account.id,
        label: `${account.name} (${account.id})`,
      })),
    });

    if (p.isCancel(selectedAccountId)) {
      process.exit(1);
    }

    accountId = selectedAccountId;
  }

  const availableBuckets: { name: string }[] = [];
  try {
    await p.tasks([
      {
        title: "Checking R2 Buckets...",
        task: async () => {
          const buckets =
            (
              await cf.r2.buckets.list({
                account_id: accountId,
              })
            ).buckets ?? [];

          availableBuckets.push(
            ...buckets.flatMap((bucket) =>
              bucket.name ? [{ name: bucket.name }] : [],
            ),
          );
        },
      },
    ]);
  } catch (error) {
    if (error instanceof Error) {
      throw toCloudflareApiError(error, infrastructureCredentialSource);
    }
    throw new Error(String(error));
  }

  const hasExistingBucket = availableBuckets.some(
    (bucket) => bucket.name === existingBucketName,
  );
  let createBucket = false;
  let selectedBucketName: string;
  if (nonInteractive && existingBucketName && hasExistingBucket) {
    selectedBucketName = existingBucketName;
    p.log.info("Using existing Cloudflare R2 bucket.");
  } else if (nonInteractive && existingBucketName) {
    selectedBucketName = existingBucketName;
    createBucket = true;
  } else {
    if (existingBucketName && !hasExistingBucket) {
      p.log.warn(
        "Saved Cloudflare R2 bucket was not found. Select a bucket again.",
      );
    }
    const selectedR2BucketName = await p.select({
      initialValue: hasExistingBucket
        ? existingBucketName
        : availableBuckets[0]?.name,
      message: "R2 List",
      options: [
        ...availableBuckets.map((bucket) => ({
          value: bucket.name,
          label: bucket.name,
        })),
        {
          value: createKey,
          label: "Create New R2 Bucket",
        },
      ],
    });

    if (p.isCancel(selectedR2BucketName)) {
      process.exit(1);
    }
    if (selectedR2BucketName === createKey) {
      const prompt = CLOUDFLARE_INIT_PROVIDER.inputs.bucketName.prompt;
      const name = await p.text({
        ...getInitProviderTextPromptValues(prompt, existingBucketName),
        message: prompt.message,
        validate: (value) => (value ? undefined : "R2 bucket name is required"),
      });
      if (p.isCancel(name)) {
        process.exit(1);
      }
      selectedBucketName = name;
      createBucket = true;
    } else {
      selectedBucketName = selectedR2BucketName;
    }
  }

  let managedDomainEnabled: boolean | undefined;
  if (!createBucket) {
    try {
      const domains = await cf.r2.buckets.domains.managed.list(
        selectedBucketName,
        {
          account_id: accountId,
        },
      );
      managedDomainEnabled = domains.enabled;
    } catch (error) {
      if (error instanceof Error) {
        throw toCloudflareApiError(error, infrastructureCredentialSource);
      }
      throw new Error(String(error));
    }
  }

  const availableD1List: { name: string; uuid: string }[] = [];
  try {
    await p.tasks([
      {
        title: "Checking D1 List...",
        task: async () => {
          const d1List =
            (await cf.d1.database.list({ account_id: accountId })).result ?? [];
          availableD1List.push(
            ...d1List.flatMap((d1) =>
              d1.name && d1.uuid ? [{ name: d1.name, uuid: d1.uuid }] : [],
            ),
          );
        },
      },
    ]);
  } catch (error) {
    if (error instanceof Error) {
      throw toCloudflareApiError(error, infrastructureCredentialSource);
    }
    throw new Error(String(error));
  }

  const existingD1Database = availableD1List.find(
    (d1) =>
      d1.uuid === existingD1DatabaseId || d1.name === existingD1DatabaseName,
  );
  let createD1Database = false;
  let selectedD1DatabaseId: string | undefined;
  let d1DatabaseName: string;
  if (nonInteractive && existingD1DatabaseId && existingD1DatabaseName) {
    const replayResolution = resolveCloudflareReplayD1Database({
      availableDatabases: availableD1List,
      databaseId: existingD1DatabaseId,
      databaseName: existingD1DatabaseName,
    });
    if (replayResolution.kind === "existing") {
      selectedD1DatabaseId = replayResolution.database.uuid;
      d1DatabaseName = replayResolution.database.name;
      p.log.info("Using existing Cloudflare D1 database.");
    } else {
      createD1Database = true;
      d1DatabaseName = replayResolution.name;
    }
  } else {
    if (
      (existingD1DatabaseId || existingD1DatabaseName) &&
      !existingD1Database
    ) {
      p.log.warn(
        "Existing Cloudflare D1 database ID was not found. Select a database again.",
      );
    }

    const selectedD1 = await p.select({
      initialValue: existingD1Database?.uuid ?? availableD1List[0]?.uuid,
      message: "D1 List",
      options: [
        ...availableD1List.map((d1) => ({
          value: d1.uuid,
          label: `${d1.name} (${d1.uuid})`,
        })),
        {
          value: createKey,
          label: "Create New D1 Database",
        },
      ],
    });

    if (p.isCancel(selectedD1)) {
      process.exit(1);
    }

    if (selectedD1 === createKey) {
      const prompt = CLOUDFLARE_INIT_PROVIDER.inputs.d1DatabaseName.prompt;
      const name = await p.text({
        ...getInitProviderTextPromptValues(prompt, existingD1DatabaseName),
        message: prompt.message,
        validate: (value) =>
          value ? undefined : "D1 database name is required",
      });
      if (p.isCancel(name)) {
        process.exit(1);
      }
      createD1Database = true;
      d1DatabaseName = name;
    } else {
      const selectedDatabase = availableD1List.find(
        (d1) => d1.uuid === selectedD1,
      );
      if (!selectedDatabase) {
        throw new Error("Failed to get D1 Database");
      }
      selectedD1DatabaseId = selectedDatabase.uuid;
      d1DatabaseName = selectedDatabase.name;
      p.log.info(`Selected D1: ${selectedD1DatabaseId}`);
    }
  }

  if (nonInteractive && existingR2AccessKeyId && existingR2SecretAccessKey) {
    p.log.info("Using existing Cloudflare R2 API credentials.");
  } else if (
    nonInteractive &&
    (existingR2AccessKeyId || existingR2SecretAccessKey)
  ) {
    p.log.warn("Existing Cloudflare R2 API credentials are incomplete.");
  }
  const initSecrets = await inputCloudflareInitSecrets({
    accountId,
    bucketName: selectedBucketName,
    apiToken: existingApiToken,
    accessKeyId: existingR2AccessKeyId,
    secretAccessKey: existingR2SecretAccessKey,
    workerName: existingWorkerName,
    nonInteractive,
  });
  const { apiToken, accessKeyId, secretAccessKey, workerName } = initSecrets;
  const privacyResolution = resolveR2Privacy({
    createBucket,
    managedDomainEnabled,
    savedPrivateSetting,
  });
  const isPrivate =
    nonInteractive && privacyResolution.kind === "resolved"
      ? privacyResolution.isPrivate
      : await p.confirm({
          message: CLOUDFLARE_INIT_PROVIDER.inputs.r2Private.prompt.message,
          initialValue:
            privacyResolution.kind === "resolved"
              ? privacyResolution.isPrivate
              : true,
        });
  if (p.isCancel(isPrivate)) {
    process.exit(1);
  }

  const databaseCredentialSource: CloudflareCredentialSource = existingApiToken
    ? envFile
      ? { envFile, kind: "env-file" }
      : { kind: "environment" }
    : { kind: "prompt" };
  const credentialClient = new Cloudflare({ apiToken });
  await validateCloudflareApiToken({
    accountId,
    probes: [
      {
        check: "D1 database access",
        request: () =>
          credentialClient.d1.database.list({
            account_id: accountId,
          }),
        requiredPermission: CLOUDFLARE_INIT_PERMISSION.d1,
      },
    ],
    source: databaseCredentialSource,
    verify: () =>
      verifyCloudflareApiTokenIdentity({
        accountId,
        apiToken,
        verifyAccountToken: (selectedAccountId) =>
          credentialClient.accounts.tokens.verify({
            account_id: selectedAccountId,
          }),
        verifyUserToken: () => credentialClient.user.tokens.verify(),
      }),
  });

  const queryD1 = async (sql: string): Promise<readonly unknown[]> => {
    if (!selectedD1DatabaseId) return [];
    const page = await cf.d1.database.query(selectedD1DatabaseId, {
      account_id: accountId,
      sql,
    });
    const rows: unknown[] = [];
    for await (const resultPage of page.iterPages()) {
      for (const result of resultPage.result) {
        rows.push(...(result.results ?? []));
      }
    }
    return rows;
  };
  if (!createD1Database) {
    const tables = (await queryD1(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table'
        AND name IN ('bundles', 'release_catalogs')
      ORDER BY name
    `)) as readonly { readonly name?: unknown }[];
    assertCloudflareInfrastructureCanInitialize(
      tables.flatMap(({ name }) => (typeof name === "string" ? [name] : [])),
      d1DatabaseName,
    );
  }

  const workerScripts = await runCloudflareApiRequest({
    request: () =>
      cf.workers.scripts.list({
        account_id: accountId,
      }),
    source: infrastructureCredentialSource,
  });
  const subdomains = await runCloudflareApiRequest({
    request: () =>
      cf.workers.subdomains.get({
        account_id: accountId,
      }),
    source: infrastructureCredentialSource,
  });
  if (!subdomains.subdomain) {
    throw new Error(
      "Cloudflare Workers subdomain is required to configure the storage download URL.",
    );
  }
  await assertCloudflareWorkerCanInitialize({
    scriptNames: workerScripts.result.flatMap(({ id }) =>
      typeof id === "string" ? [id] : [],
    ),
    workerName,
    workersSubdomain: subdomains.subdomain,
  });

  const resolvedInputs = {
    ...existingInputs,
    accessKeyId,
    accountId,
    apiToken,
    bucketName: selectedBucketName,
    d1DatabaseId: selectedD1DatabaseId,
    d1DatabaseName,
    r2Private: String(isPrivate),
    secretAccessKey,
    workerName,
  };
  const persistCredentialInputs = await confirmInitInputPersistence({
    existingEnv: managedEnv,
    inputs: resolvedInputs,
    nonInteractive,
    provider: CLOUDFLARE_INIT_PROVIDER,
  });
  await makeEnv({
    ...getInitProviderEnvVars({
      includeConsentInputs: persistCredentialInputs,
      inputs: resolvedInputs,
      provider: CLOUDFLARE_INIT_PROVIDER,
    }),
  });

  // The plugins the Worker runs: the package's, or those of the project's
  // edited definition, which reads what .env.hotupdater now holds. It is
  // checked and bundled before init creates a bucket or a database.
  const serverPlugins = definition.edited
    ? await loadManagedServerDefinition(
        definition,
        (hotUpdater) => {
          const loaded = managedServerDefinitionOf(hotUpdater, {
            provider: "Cloudflare",
            database: "d1Database",
            storage: "r2",
            resources: {
              database: { accountId, databaseId: selectedD1DatabaseId },
              storage: { accountId, bucketName: selectedBucketName },
            },
          });
          // A clientAuth plugin must give init the credential an app sends.
          clientAuthOf(loaded);
          return loaded.plugins;
        },
        { cwd },
      )
    : plugins;
  const staged = await stageWorker(
    definition.edited ? definition.path : undefined,
  );
  try {
    if (createBucket) {
      const newR2 = await runCloudflareApiRequest({
        request: () =>
          cf.r2.buckets.create({
            account_id: accountId,
            name: selectedBucketName,
          }),
        source: infrastructureCredentialSource,
      });
      if (!newR2.name) {
        throw new Error("Failed to create new R2 Bucket");
      }
      p.log.info(`Created R2: ${newR2.name}`);
      const domains = await runCloudflareApiRequest({
        request: () =>
          cf.r2.buckets.domains.managed.list(selectedBucketName, {
            account_id: accountId,
          }),
        source: infrastructureCredentialSource,
      });
      managedDomainEnabled = domains.enabled;
    } else {
      p.log.info(`Selected R2: ${selectedBucketName}`);
    }

    if (managedDomainEnabled === undefined) {
      throw new Error("Failed to resolve the R2 managed domain state.");
    }
    if (
      shouldUpdateR2ManagedDomain({
        isPrivate,
        managedDomainEnabled,
      })
    ) {
      await p.tasks([
        {
          title: `Making R2 bucket ${isPrivate ? "private" : "public"}...`,
          task: async () => {
            await runCloudflareApiRequest({
              request: () =>
                cf.r2.buckets.domains.managed.update(selectedBucketName, {
                  account_id: accountId,
                  enabled: !isPrivate,
                }),
              source: infrastructureCredentialSource,
            });
          },
        },
      ]);
    }

    if (createD1Database) {
      const newD1 = await runCloudflareApiRequest({
        request: () =>
          cf.d1.database.create({
            account_id: accountId,
            name: d1DatabaseName,
          }),
        source: infrastructureCredentialSource,
      });
      if (!newD1.uuid || !newD1.name) {
        throw new Error("Failed to create the requested D1 Database");
      }
      selectedD1DatabaseId = newD1.uuid;
      d1DatabaseName = newD1.name;
      p.log.info(`Created D1 Database: ${newD1.name} (${newD1.uuid})`);
    }
    if (!selectedD1DatabaseId) {
      throw new Error("Failed to resolve the D1 Database");
    }
    await makeEnv({
      [CLOUDFLARE_INIT_PROVIDER.inputs.d1DatabaseId.envKey]:
        selectedD1DatabaseId,
      [CLOUDFLARE_INIT_PROVIDER.inputs.d1DatabaseName.envKey]: d1DatabaseName,
    });

    await deployWorker(infrastructureApiToken, accountId, {
      credentialSource: infrastructureCredentialSource,
      d1DatabaseId: selectedD1DatabaseId,
      d1DatabaseName,
      nonInteractive,
      plugins: serverPlugins,
      r2BucketName: selectedBucketName,
      staged,
      workerName,
    });
  } finally {
    await staged.remove();
  }

  const database = d1Database({
    accountId,
    cloudflareApiToken: apiToken,
    databaseId: selectedD1DatabaseId,
  });
  // The managed server's plugins over the database init set up, which
  // creating it neither reads nor writes.
  const managedServer = createHotUpdater({
    database,
    plugins: serverPlugins,
    ...(serverPlugins.some(({ provides }) => provides?.clientAuth)
      ? {}
      : { clientAccess: "public" }),
  } as Parameters<typeof createHotUpdater>[0]);
  // The app's credential, through the managed server's plugins, on the tables they read.
  let credential: ProvisionedClientCredential | undefined;
  try {
    credential = await provisionClientCredential(managedServer, {
      env: initInputEnv,
      name: "Cloudflare init",
    });
    if (credential !== undefined) {
      await makeEnv({ [credential.env]: credential.value });
    }
  } finally {
    await database.dispose?.();
  }

  p.log.success("Generated '.env.hotupdater' file with Cloudflare settings.");
  await writeHotUpdaterFiles(scaffold, { cwd, settings: "Cloudflare" });

  printAppSetup({
    ...(subdomains.subdomain
      ? {
          baseURL: `https://${workerName}.${subdomains.subdomain}.workers.dev`,
        }
      : {}),
    ...(credential === undefined ? {} : { credential }),
    clientPlugins: managedServer.clientPlugins,
  });

  p.log.message(
    `Next step: ${link(
      "https://hot-updater.dev/docs/managed/cloudflare#step-3-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};

// What init asks for and checks before `runInit`, and the server definitions
// it writes.
export { initProvider } from "./init/index";
