import * as p from "@clack/prompts";
import {
  type BuildType,
  ConfigBuilder,
  copyDirToTmp,
  getCwd,
  link,
  makeEnv,
  type ProviderConfig,
  transformTemplate,
} from "@hot-updater/plugin-core";
import { Cloudflare } from "cloudflare";
import crypto from "crypto";
import dayjs from "dayjs";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";
import { createWrangler } from "../src/utils/createWrangler";
import { getWranglerLoginAuthToken } from "./getWranglerLoginAuthToken";

const getConfigTemplate = (build: BuildType) => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/cloudflare", named: ["r2Storage"] }],
    configString: `r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
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

  return new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .getResult();
};

const SOURCE_TEMPLATE = `// add this to your App.tsx
import { HotUpdater, getUpdateSource } from "@hot-updater/react-native";

function App() {
  return ...
}

export default HotUpdater.wrap({
  source: getUpdateSource("%%source%%", {
    updateStrategy: "appVersion", // or "fingerprint"
  }),
})(App);`;

const deployWorker = async (
  oauth_token: string,
  accountId: string,
  {
    d1DatabaseId,
    d1DatabaseName,
    r2BucketName,
  }: { d1DatabaseId: string; d1DatabaseName: string; r2BucketName: string },
) => {
  const cwd = getCwd();
  const workerPath = require.resolve("@hot-updater/cloudflare/worker", {
    paths: [cwd],
  });
  const wranglerTemplateDir = path.dirname(workerPath);
  const { tmpDir, removeTmpDir } = await copyDirToTmp(wranglerTemplateDir);

  try {
    const wranglerConfig = JSON.parse(
      await fs.readFile(path.join(tmpDir, "wrangler.json"), "utf-8"),
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
      path.join(tmpDir, "wrangler.json"),
      JSON.stringify(wranglerConfig, null, 2),
    );

    const wrangler = await createWrangler({
      stdio: "inherit",
      cloudflareApiToken: oauth_token,
      cwd: tmpDir,
      accountId: accountId,
    });

    const migrationPath = await path.join(tmpDir, "migrations");
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

    const workerName = await p.text({
      message: "Enter the name of the worker",
      defaultValue: "hot-updater",
      placeholder: "hot-updater",
    });
    if (p.isCancel(workerName)) {
      process.exit(1);
    }

    await wrangler("deploy", "--name", workerName);
    return workerName;
  } catch (error) {
    throw new Error("Failed to deploy worker", { cause: error });
  } finally {
    await removeTmpDir();
  }
};

export const runInit = async ({ build }: { build: BuildType }) => {
  const cwd = getCwd();

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

  const accountId = await p.select({
    message: "Account List",
    options: accounts.map((account) => ({
      value: account.id,
      label: `${account.name} (${account.id})`,
    })),
  });

  if (p.isCancel(accountId)) {
    process.exit(1);
  }

  p.log.step(
    `Please visit this link to create an API Token: ${link(
      `https://dash.cloudflare.com/${accountId}/api-tokens`,
    )}`,
  );
  p.log.step("You need edit permissions for both D1 and R2");

  const apiToken = await p.password({
    message: "Enter the API Token",
  });

  if (!apiToken) {
    p.log.warn(
      "Skipping API Token. You can set it later in .env HOT_UPDATER_CLOUDFLARE_API_TOKEN file.",
    );
  }

  if (p.isCancel(apiToken)) {
    process.exit(1);
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

  let selectedBucketName = await p.select({
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

  if (p.isCancel(selectedBucketName)) {
    process.exit(1);
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
  p.log.info(`Selected R2: ${selectedBucketName}`);

  //

  const domains = await cf.r2.buckets.domains.managed.list(selectedBucketName, {
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

  let selectedD1DatabaseId = await p.select({
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

  if (p.isCancel(selectedD1DatabaseId)) {
    process.exit(1);
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

  const workerName = await deployWorker(auth.oauth_token, accountId, {
    d1DatabaseId: selectedD1DatabaseId,
    d1DatabaseName,
    r2BucketName: selectedBucketName,
  });

  await fs.writeFile("hot-updater.config.ts", getConfigTemplate(build));

  await makeEnv({
    HOT_UPDATER_CLOUDFLARE_API_TOKEN: apiToken,
    HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: accountId,
    HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME: selectedBucketName,
    HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: selectedD1DatabaseId,
  });
  p.log.success("Generated '.env.hotupdater' file with Cloudflare settings.");
  p.log.success(
    "Generated 'hot-updater.config.ts' file with Cloudflare settings.",
  );

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
