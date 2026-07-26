import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import {
  CLOUDFLARE_INIT_PROVIDER,
  ConfigBuilder,
  confirmInitInputPersistence,
  copyDirToTmp,
  createHotUpdaterConfigScaffoldFromBuilder,
  getInitProviderEnvVars,
  getCwd,
  type HotUpdaterConfigScaffold,
  link,
  makeEnv,
  type ProviderConfig,
  p,
  readHotUpdaterInitEnv,
  type RunInitOptions,
  shouldAutoSelectOnlyInitResource,
  transformTemplate,
  writeHotUpdaterConfig,
} from "@hot-updater/cli-tools";
import { Cloudflare } from "cloudflare";
import dayjs from "dayjs";
import { execa } from "execa";

import { createWrangler } from "../src/utils/createWrangler";
import {
  assertCloudflareNonInteractiveInputs,
  resolveCloudflareInitInputs,
  shouldUpdateR2ManagedDomain,
} from "./cloudflareInitInputs";
import { inputCloudflareInitSecrets } from "./cloudflareInitSecrets";
import { getWranglerLoginAuthToken } from "./getWranglerLoginAuthToken";

const getConfigScaffold = (
  build: RunInitOptions["build"],
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
  );
};

const SOURCE_TEMPLATE = `// add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return ...
}

export default HotUpdater.wrap({
  baseURL: "%%source%%",
  updateStrategy: "appVersion", // or "fingerprint"
})(App);`;

const deployWorker = async (
  oauth_token: string,
  accountId: string,
  {
    d1DatabaseId,
    d1DatabaseName,
    nonInteractive,
    r2BucketName,
    workerName,
  }: {
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

    const jwtSecret = crypto.randomBytes(32).toString("hex");

    wranglerConfig.vars = {
      JWT_SECRET: jwtSecret,
    };

    await fs.writeFile(
      path.join(workerRoot, "wrangler.json"),
      JSON.stringify(wranglerConfig, null, 2),
    );

    const wrangler = await createWrangler({
      stdio: "inherit",
      cloudflareApiToken: oauth_token,
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
    return workerName;
  } catch (error) {
    throw new Error("Failed to deploy worker", { cause: error });
  } finally {
    await removeTmpDir();
  }
};

export const runInit = async ({ build, envFile }: RunInitOptions) => {
  const cwd = getCwd();
  const nonInteractive = envFile !== undefined;
  const { env: existingEnv, managedEnv } = await readHotUpdaterInitEnv(
    cwd,
    envFile,
  );
  const existingInputs = resolveCloudflareInitInputs(existingEnv);
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

  let infrastructureApiToken = existingApiToken;
  if (!infrastructureApiToken) {
    let auth = getWranglerLoginAuthToken();
    if (!auth || dayjs(auth.expiration_time).isBefore(dayjs())) {
      await execa(
        "npx",
        [
          "wrangler",
          "login",
          "--scopes",
          "account:read",
          "user:read",
          "d1:write",
          "workers:write",
          "workers_scripts:write",
        ],
        { cwd },
      );
      auth = getWranglerLoginAuthToken();
    }
    if (!auth) {
      throw new Error("'npx wrangler login' is required to use this command");
    }
    infrastructureApiToken = auth.oauth_token;
  }

  const cf = new Cloudflare({
    apiToken: infrastructureApiToken,
  });

  const createKey = `create/${Math.random().toString(36).substring(2, 15)}`;

  let accountId = existingAccountId;
  if (accountId) {
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
    } catch (e) {
      if (e instanceof Error) {
        p.log.error(e.message);
      }
      throw e;
    }

    if (accounts.length === 1 && accounts[0]) {
      accountId = accounts[0].id;
      p.log.info("Using the only Cloudflare account.");
    } else {
      const selectedAccountId = await p.select({
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
  } catch (e) {
    if (e instanceof Error) {
      p.log.error(e.message);
    }
    throw e;
  }

  const hasExistingBucket = availableBuckets.some(
    (bucket) => bucket.name === existingBucketName,
  );
  let createBucket = false;
  let selectedBucketName: string;
  if (existingBucketName && hasExistingBucket) {
    selectedBucketName = existingBucketName;
    p.log.info("Using existing Cloudflare R2 bucket.");
  } else if (nonInteractive && existingBucketName) {
    selectedBucketName = existingBucketName;
    createBucket = true;
  } else if (
    shouldAutoSelectOnlyInitResource({
      availableResourceCount: availableBuckets.length,
      savedIdentifier: existingBucketName,
    }) &&
    availableBuckets[0]
  ) {
    selectedBucketName = availableBuckets[0].name;
    p.log.info("Using the only Cloudflare R2 bucket.");
  } else {
    if (existingBucketName) {
      p.log.warn(
        "Saved Cloudflare R2 bucket was not found. Select a bucket again.",
      );
    }
    const selectedR2BucketName = await p.select({
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
      const name = await p.text({
        message: CLOUDFLARE_INIT_PROVIDER.inputs.bucketName.prompt.message,
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

  if (existingR2AccessKeyId && existingR2SecretAccessKey) {
    p.log.info("Using existing Cloudflare R2 API credentials.");
  } else if (existingR2AccessKeyId || existingR2SecretAccessKey) {
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
  const isPrivate =
    savedPrivateSetting === "true"
      ? true
      : savedPrivateSetting === "false"
        ? false
        : await p.confirm({
            message: CLOUDFLARE_INIT_PROVIDER.inputs.r2Private.prompt.message,
            initialValue: true,
          });
  if (p.isCancel(isPrivate)) {
    process.exit(1);
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
  } catch (e) {
    if (e instanceof Error) {
      p.log.error(e.message);
    }
    throw e;
  }

  const existingD1Database = availableD1List.find(
    (d1) =>
      d1.uuid === existingD1DatabaseId ||
      (nonInteractive && d1.name === existingD1DatabaseName),
  );
  let createD1Database = false;
  let selectedD1DatabaseId: string | undefined;
  let d1DatabaseName: string;
  if (existingD1Database) {
    selectedD1DatabaseId = existingD1Database.uuid;
    d1DatabaseName = existingD1Database.name;
    p.log.info("Using existing Cloudflare D1 database.");
  } else if (nonInteractive && existingD1DatabaseId && existingD1DatabaseName) {
    createD1Database = true;
    d1DatabaseName = existingD1DatabaseName;
  } else if (
    shouldAutoSelectOnlyInitResource({
      availableResourceCount: availableD1List.length,
      savedIdentifier: existingD1DatabaseId ?? existingD1DatabaseName,
    }) &&
    availableD1List[0]
  ) {
    selectedD1DatabaseId = availableD1List[0].uuid;
    d1DatabaseName = availableD1List[0].name;
    p.log.info("Using the only Cloudflare D1 database.");
  } else {
    if (existingD1DatabaseId) {
      p.log.warn(
        "Existing Cloudflare D1 database ID was not found. Select a database again.",
      );
    }

    const selectedD1 = await p.select({
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
      const name = await p.text({
        message: CLOUDFLARE_INIT_PROVIDER.inputs.d1DatabaseName.prompt.message,
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
  infrastructureApiToken = apiToken;

  if (createBucket) {
    const newR2 = await cf.r2.buckets.create({
      account_id: accountId,
      name: selectedBucketName,
    });
    if (!newR2.name) {
      throw new Error("Failed to create new R2 Bucket");
    }
    p.log.info(`Created R2: ${newR2.name}`);
  } else {
    p.log.info(`Selected R2: ${selectedBucketName}`);
  }

  const domains = await cf.r2.buckets.domains.managed.list(selectedBucketName, {
    account_id: accountId,
  });
  if (
    shouldUpdateR2ManagedDomain({
      isPrivate,
      managedDomainEnabled: domains.enabled,
    })
  ) {
    try {
      await p.tasks([
        {
          title: `Making R2 bucket ${isPrivate ? "private" : "public"}...`,
          task: async () => {
            await cf.r2.buckets.domains.managed.update(selectedBucketName, {
              account_id: accountId,
              enabled: !isPrivate,
            });
          },
        },
      ]);
    } catch (e) {
      if (e instanceof Error) {
        p.log.error(e.message);
      }
      throw e;
    }
  }

  if (createD1Database) {
    const newD1 = await cf.d1.database.create({
      account_id: accountId,
      name: d1DatabaseName,
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

  const subdomains = await cf.workers.subdomains.get({
    account_id: accountId,
  });

  await deployWorker(infrastructureApiToken, accountId, {
    d1DatabaseId: selectedD1DatabaseId,
    d1DatabaseName,
    nonInteractive,
    r2BucketName: selectedBucketName,
    workerName,
  });

  const configWriteResult = await writeHotUpdaterConfig(
    getConfigScaffold(build),
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
        source: `https://${workerName}.${subdomains.subdomain}.workers.dev/api/check-update`,
      }),
    );
  }

  p.log.message(
    `Next step: ${link(
      "https://hot-updater.dev/docs/managed/cloudflare#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
