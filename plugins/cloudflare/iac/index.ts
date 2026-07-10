// noqa: SIZE_OK - Existing Cloudflare IAC module; splitting belongs to a dedicated provider cleanup.
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import {
  type BuildType,
  ConfigBuilder,
  copyDirToTmp,
  createHotUpdaterConfigScaffoldFromBuilder,
  getCwd,
  type HotUpdaterConfigScaffold,
  link,
  makeEnv,
  type ProviderConfig,
  p,
  transformTemplate,
  writeHotUpdaterConfig,
} from "@hot-updater/cli-tools";
import { Cloudflare } from "cloudflare";
import dayjs from "dayjs";
import { execa } from "execa";

import { createWrangler } from "../src/utils/createWrangler";
import { getWranglerLoginAuthToken } from "./getWranglerLoginAuthToken";

const getConfigScaffold = (build: BuildType): HotUpdaterConfigScaffold => {
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
    imports: [{ pkg: "@hot-updater/cloudflare/worker", named: ["d1Database"] }],
    configString: "d1Database()",
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

const HOT_UPDATER_ENV_PATH = ".env.hotupdater";

type R2ApiCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

const unquoteEnvValue = (value: string) => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
};

const readHotUpdaterEnv = async (cwd: string) => {
  const envPath = path.join(cwd, HOT_UPDATER_ENV_PATH);
  const content = await fs.readFile(envPath, "utf-8").catch(() => "");
  const env: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [key, ...valueParts] = trimmed.split("=");
    if (!key) {
      continue;
    }

    env[key.trim()] = unquoteEnvValue(valueParts.join("="));
  }

  return env;
};

const getEnvValue = (env: Record<string, string>, key: string) => {
  const value = process.env[key]?.trim() || env[key]?.trim();
  return value || undefined;
};

const inputR2ApiCredentials = async ({
  accountId,
  bucketName,
  accessKeyId,
  secretAccessKey,
}: {
  accountId: string;
  bucketName: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}): Promise<R2ApiCredentials> => {
  p.log.step(
    `R2 API Tokens dashboard: ${link(
      `https://dash.cloudflare.com/${accountId}/r2/api-tokens`,
    )}`,
  );
  p.log.step("Required permission: Object Read & Write");
  p.log.step(`Target bucket: ${bucketName}`);

  let resolvedAccessKeyId = accessKeyId;
  if (!resolvedAccessKeyId) {
    const inputR2AccessKeyId = await p.password({
      message: "Enter the R2 Access Key ID",
    });

    if (p.isCancel(inputR2AccessKeyId)) {
      process.exit(1);
    }

    resolvedAccessKeyId = inputR2AccessKeyId;
  }

  let resolvedSecretAccessKey = secretAccessKey;
  if (!resolvedSecretAccessKey) {
    const inputR2SecretAccessKey = await p.password({
      message: "Enter the R2 Secret Access Key",
    });

    if (p.isCancel(inputR2SecretAccessKey)) {
      process.exit(1);
    }

    resolvedSecretAccessKey = inputR2SecretAccessKey;
  }

  return {
    accessKeyId: resolvedAccessKeyId,
    secretAccessKey: resolvedSecretAccessKey,
  };
};

const deployWorker = async (
  oauth_token: string,
  accountId: string,
  {
    d1DatabaseId,
    d1DatabaseName,
    r2BucketName,
    workerName,
  }: {
    d1DatabaseId: string;
    d1DatabaseName: string;
    r2BucketName: string;
    workerName?: string;
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

    let resolvedWorkerName = workerName;
    if (resolvedWorkerName) {
      p.log.info("Using existing Cloudflare Worker name.");
    } else {
      const inputWorkerName = await p.text({
        message: "Enter the name of the worker",
        defaultValue: "hot-updater",
        placeholder: "hot-updater",
      });
      if (p.isCancel(inputWorkerName)) {
        process.exit(1);
      }
      resolvedWorkerName = inputWorkerName;
    }

    await wrangler("deploy", "--name", resolvedWorkerName);
    return resolvedWorkerName;
  } catch (error) {
    throw new Error("Failed to deploy worker", { cause: error });
  } finally {
    await removeTmpDir();
  }
};

export const runInit = async ({ build }: { build: BuildType }) => {
  const cwd = getCwd();
  const existingEnv = await readHotUpdaterEnv(cwd);

  let auth = getWranglerLoginAuthToken();

  if (!auth || dayjs(auth?.expiration_time).isBefore(dayjs())) {
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

  const cf = new Cloudflare({
    apiToken: auth.oauth_token,
  });

  const createKey = `create/${Math.random().toString(36).substring(2, 15)}`;

  const existingAccountId = getEnvValue(
    existingEnv,
    "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID",
  );

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

    const selectedAccountId = await p.select({
      message: "Account List",
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

  const existingApiToken = getEnvValue(
    existingEnv,
    "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
  );
  let apiToken = existingApiToken;
  if (apiToken) {
    p.log.info("Using existing Cloudflare API token.");
  } else {
    p.log.step(
      `D1 API Token dashboard: ${link(
        `https://dash.cloudflare.com/${accountId}/api-tokens`,
      )}`,
    );
    p.log.step("Required permission: D1 Edit");
    p.log.step("Used for bundle metadata writes after init.");

    const inputApiToken = await p.password({
      message: "Enter the D1 API Token",
    });

    if (p.isCancel(inputApiToken)) {
      process.exit(1);
    }

    apiToken = inputApiToken;

    if (!apiToken) {
      p.log.warn(
        "Skipping API Token. You can set it later in .env HOT_UPDATER_CLOUDFLARE_API_TOKEN file.",
      );
    }
  }

  const existingBucketName = getEnvValue(
    existingEnv,
    "HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME",
  );

  let selectedBucketName: string;
  if (existingBucketName) {
    selectedBucketName = existingBucketName;
    p.log.info("Using existing Cloudflare R2 bucket name.");
  } else {
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
              ...buckets
                .filter((bucket) => bucket.name)
                .map((bucket) => ({
                  name: bucket.name!,
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

    if (availableBuckets.length === 1) {
      selectedBucketName = availableBuckets[0].name;
      p.log.info("Using the only Cloudflare R2 bucket.");
    } else {
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

      selectedBucketName = selectedR2BucketName;
    }

    if (selectedBucketName === createKey) {
      const name = await p.text({
        message: "Enter the name of the new R2 Bucket",
      });
      if (p.isCancel(name)) {
        process.exit(1);
      }
      const newR2 = await cf.r2.buckets.create({
        account_id: accountId,
        name,
      });
      if (!newR2.name) {
        throw new Error("Failed to create new R2 Bucket");
      }

      selectedBucketName = newR2.name;
    }
  }
  p.log.info(`Selected R2: ${selectedBucketName}`);

  const existingR2AccessKeyId = getEnvValue(
    existingEnv,
    "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
  );
  const existingR2SecretAccessKey = getEnvValue(
    existingEnv,
    "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  );

  let r2AccessKeyId = existingR2AccessKeyId;
  let r2SecretAccessKey = existingR2SecretAccessKey;

  if (r2AccessKeyId && r2SecretAccessKey) {
    p.log.info("Using existing Cloudflare R2 API credentials.");
  } else if (r2AccessKeyId || r2SecretAccessKey) {
    p.log.warn("Existing Cloudflare R2 API credentials are incomplete.");
    const credentials = await inputR2ApiCredentials({
      accountId,
      bucketName: selectedBucketName,
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
    });
    r2AccessKeyId = credentials.accessKeyId;
    r2SecretAccessKey = credentials.secretAccessKey;
  } else {
    const credentials = await inputR2ApiCredentials({
      accountId,
      bucketName: selectedBucketName,
    });
    r2AccessKeyId = credentials.accessKeyId;
    r2SecretAccessKey = credentials.secretAccessKey;
  }

  //

  const domains = existingBucketName
    ? { enabled: false }
    : await cf.r2.buckets.domains.managed.list(selectedBucketName, {
        account_id: accountId,
      });

  if (domains.enabled) {
    const isPrivate = await p.confirm({
      message: "Make R2 bucket private?",
    });

    if (isPrivate) {
      try {
        await p.tasks([
          {
            title: "Making R2 bucket private...",
            task: async () => {
              await cf.r2.buckets.domains.managed.update(selectedBucketName, {
                account_id: accountId,
                enabled: false,
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
            ...d1List
              .filter((d1) => d1.name || d1.uuid)
              .map((d1) => ({
                name: d1.name!,
                uuid: d1.uuid!,
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

  const existingD1DatabaseId = getEnvValue(
    existingEnv,
    "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID",
  );
  const hasExistingD1Database = availableD1List.some(
    (d1) => d1.uuid === existingD1DatabaseId,
  );

  let selectedD1DatabaseId: string;
  if (existingD1DatabaseId && hasExistingD1Database) {
    selectedD1DatabaseId = existingD1DatabaseId;
    p.log.info("Using existing Cloudflare D1 database ID.");
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

    selectedD1DatabaseId = selectedD1;
  }

  if (selectedD1DatabaseId === createKey) {
    const name = await p.text({
      message: "Enter the name of the new D1 Database",
    });
    if (p.isCancel(name)) {
      process.exit(1);
    }
    const newD1 = await cf.d1.database.create({
      account_id: accountId,
      name,
    });
    if (!newD1.uuid || !newD1.name) {
      throw new Error("Failed to create new D1 Database");
    }

    selectedD1DatabaseId = newD1.uuid;
    availableD1List.push({
      name: newD1.name,
      uuid: newD1.uuid,
    });
    p.log.info(`Created new D1 Database: ${newD1.name} (${newD1.uuid})`);
  } else {
    p.log.info(`Selected D1: ${selectedD1DatabaseId}`);
  }

  const d1DatabaseName = availableD1List.find(
    (d1) => d1.uuid === selectedD1DatabaseId,
  )?.name;

  if (!d1DatabaseName) {
    throw new Error("Failed to get D1 Database name");
  }

  const subdomains = await cf.workers.subdomains.get({
    account_id: accountId,
  });

  const existingWorkerName = getEnvValue(
    existingEnv,
    "HOT_UPDATER_CLOUDFLARE_WORKER_NAME",
  );

  const workerName = await deployWorker(auth.oauth_token, accountId, {
    d1DatabaseId: selectedD1DatabaseId,
    d1DatabaseName,
    r2BucketName: selectedBucketName,
    workerName: existingWorkerName,
  });

  const configWriteResult = await writeHotUpdaterConfig(
    getConfigScaffold(build),
  );

  await makeEnv({
    HOT_UPDATER_CLOUDFLARE_API_TOKEN: apiToken,
    HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: accountId,
    HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME: selectedBucketName,
    HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: r2AccessKeyId,
    HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY: r2SecretAccessKey,
    HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: selectedD1DatabaseId,
    HOT_UPDATER_CLOUDFLARE_WORKER_NAME: workerName,
  });
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
