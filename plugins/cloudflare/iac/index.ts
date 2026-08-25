import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import {
  ConfigBuilder,
  confirmInitInputPersistence,
  copyDirToTmp,
  createHotUpdaterConfigScaffoldFromBuilder,
  formatApiKeyNote,
  getHotUpdaterInitInputEnv,
  getInitProviderEnvVars,
  getInitProviderTextPromptValues,
  getCwd,
  type HotUpdaterConfigScaffold,
  link,
  makeEnv,
  type ProviderConfig,
  p,
  readHotUpdaterInitEnv,
  type RunInitOptions,
  transformTemplate,
  writeHotUpdaterConfig,
} from "@hot-updater/cli-tools";
import { provisionApiKey } from "@hot-updater/server";
import { Cloudflare } from "cloudflare";

import { d1Database } from "../src/d1Database";
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
import { initProvider as CLOUDFLARE_INIT_PROVIDER } from "./init/index";

const getConfigScaffold = (
  build: RunInitOptions["build"],
  authorityId: string,
): HotUpdaterConfigScaffold => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/cloudflare", named: ["r2Storage"] }],
    configString: `r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    credentials: {
      accessKeyId: process.env.HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
    },
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/cloudflare", named: ["d1Database"] }],
    configString: `d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  })`,
  };

  return createHotUpdaterConfigScaffoldFromBuilder(
    new ConfigBuilder()
      .setBuildType(build)
      .setStorage(storageConfig)
      .setDatabase(databaseConfig),
    { authorityIdInitializer: JSON.stringify(authorityId) },
  );
};

const SOURCE_TEMPLATE = `// add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return null; // Replace with your app root
}

HotUpdater.init({
  baseURL: "%%source%%",
  requestHeaders: {
    "x-api-key": %%apiKey%%,
  },
});

// Call HotUpdater.checkForUpdate({ updateStrategy: "appVersion" })
// when your app is ready to check.
export default App;`;

const deployWorker = async (
  apiToken: string,
  accountId: string,
  {
    credentialSource,
    d1DatabaseId,
    d1DatabaseName,
    nonInteractive,
    r2BucketName,
    workerName,
  }: {
    credentialSource: CloudflareCredentialSource;
    d1DatabaseId: string;
    d1DatabaseName: string;
    nonInteractive: boolean;
    r2BucketName: string;
    workerName: string;
  },
) => {
  const cwd = getCwd();
  const cloudflarePackagePath = require.resolve(
    "@hot-updater/cloudflare/package.json",
    {
      paths: [cwd],
    },
  );
  const cloudflarePackageRoot = path.dirname(cloudflarePackagePath);
  const { tmpDir, removeTmpDir } = await copyDirToTmp(cloudflarePackageRoot);
  const workerRoot = path.join(tmpDir, "worker");

  try {
    const wranglerConfig = JSON.parse(
      await fs.readFile(path.join(workerRoot, "wrangler.json"), "utf-8"),
    );

    wranglerConfig.d1_databases = [
      {
        binding: "DB",
        database_id: d1DatabaseId,
        database_name: d1DatabaseName,
      },
    ];

    wranglerConfig.r2_buckets = [
      {
        binding: "BUCKET",
        bucket_name: r2BucketName,
      },
    ];

    wranglerConfig.vars = {
      AUTHORITY_ID: d1DatabaseId,
      BUCKET_NAME: r2BucketName,
    };

    await fs.writeFile(
      path.join(workerRoot, "wrangler.json"),
      JSON.stringify(wranglerConfig, null, 2),
    );

    const wrangler = await createWrangler({
      stdio: "inherit",
      cloudflareApiToken: apiToken,
      cwd: workerRoot,
      accountId: accountId,
      nonInteractive,
    });

    const migrationPath = await path.join(workerRoot, "migrations");
    const migrationFiles = await fs.readdir(migrationPath);
    for (const file of migrationFiles) {
      if (file.endsWith(".sql")) {
        const filePath = path.join(migrationPath, file);
        const content = await fs.readFile(filePath, "utf-8");
        await fs.writeFile(
          filePath,
          transformTemplate(content, {
            BUCKET_NAME: r2BucketName,
          }),
        );
      }
    }

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
  } finally {
    await removeTmpDir();
  }
};

export const runInit = async ({ build, envFile }: RunInitOptions) => {
  const cwd = getCwd();
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
    [CLOUDFLARE_INIT_PROVIDER.inputs.d1DatabaseId.envKey]: selectedD1DatabaseId,
    [CLOUDFLARE_INIT_PROVIDER.inputs.d1DatabaseName.envKey]: d1DatabaseName,
  });

  await deployWorker(infrastructureApiToken, accountId, {
    credentialSource: infrastructureCredentialSource,
    d1DatabaseId: selectedD1DatabaseId,
    d1DatabaseName,
    nonInteractive,
    r2BucketName: selectedBucketName,
    workerName,
  });

  const databasePlugin = d1Database({
    accountId,
    cloudflareApiToken: apiToken,
    databaseId: selectedD1DatabaseId,
  });
  let apiKey: string;
  try {
    apiKey = (
      await provisionApiKey({
        apiKeys: databasePlugin.models.apiKeys,
        existingApiKey: initInputEnv.HOT_UPDATER_API_KEY,
        name: "Cloudflare init",
      })
    ).apiKey;
    await makeEnv({ HOT_UPDATER_API_KEY: apiKey });
  } finally {
    await databasePlugin.dispose?.();
  }

  const configWriteResult = await writeHotUpdaterConfig(
    getConfigScaffold(build, selectedD1DatabaseId),
  );

  p.log.success("Generated '.env.hotupdater' file with Cloudflare settings.");
  if (configWriteResult.status === "created") {
    p.log.success(
      "Generated 'hot-updater.config.ts' file with Cloudflare settings.",
    );
  } else if (configWriteResult.status === "merged") {
    p.log.success(
      "Updated 'hot-updater.config.ts' file with Cloudflare settings.",
    );
  } else {
    p.log.warn(
      `Kept existing 'hot-updater.config.ts' unchanged: ${configWriteResult.reason}`,
    );
  }

  if (subdomains.subdomain) {
    p.note(
      transformTemplate(SOURCE_TEMPLATE, {
        apiKey: JSON.stringify(apiKey),
        source: `https://${workerName}.${subdomains.subdomain}.workers.dev`,
      }),
    );
  }
  p.note(formatApiKeyNote(apiKey), "API Key");
  p.log.message("Store this API key separately in a secure place.");

  p.log.message(
    `Next step: ${link(
      "https://hot-updater.dev/docs/managed/cloudflare#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
