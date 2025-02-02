import { link } from "@/components/banner";
import { makeEnv } from "@/utils/makeEnv";
import * as p from "@clack/prompts";
import { getCwd } from "@hot-updater/plugin-core";
import { execa } from "execa";

import fs from "fs/promises";

const CONFIG_TEMPLATE = `
import { metro } from "@hot-updater/metro";
import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import { defineConfig } from "hot-updater";
import "dotenv/config";

export default defineConfig({
  build: metro(),
  storage: r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
  database: d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
});
`;

// const SOURCE_TEMPLATE = `// add this to your App.tsx
// import { HotUpdater } from "@hot-updater/react-native";

// function App() {
//   return ...
// }

// export default HotUpdater.wrap({
//   source: "%%source%%",
// })(App);`;

export const initCloudflareD1R2Worker = async () => {
  const cwd = getCwd();

  const { Cloudflare, getWranglerLoginAuthToken } = await import(
    "@hot-updater/cloudflare/utils"
  );

  let auth = getWranglerLoginAuthToken();

  if (!auth) {
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
      ],
      { cwd },
    );
    auth = getWranglerLoginAuthToken();
  }
  if (!auth) {
    throw new Error("'npx wrangler login' is required to use this command");
  }

  // const wrangler = await createWrangler({
  //   cloudflareApiToken: auth.oauth_token,
  //   cwd: getCwd(),
  // });

  const cf = new Cloudflare({
    apiToken: auth.oauth_token,
  });

  const s = p.spinner();
  const createKey = `create/${Math.random().toString(36).substring(2, 15)}`;

  s.start("Checking Account List...");
  const accounts = await cf.accounts.list();
  s.stop();

  const accountId = await p.select({
    message: "Account List",
    options: accounts.result.map((account) => ({
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

  if (p.isCancel(apiToken)) {
    process.exit(1);
  }

  s.start("Checking R2 Buckets...");
  const buckets =
    (
      await cf.r2.buckets.list({
        account_id: accountId,
      })
    ).buckets ?? [];
  const availableBuckets = buckets.filter((bucket) => bucket.name) as {
    name: string;
  }[];
  s.stop();

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

  s.start("Making R2 bucket publicly accessible...");
  await cf.r2.buckets.domains.managed.update(selectedBucketName, {
    account_id: accountId,
    enabled: true,
  });
  s.stop();

  s.start("Checking D1 List...");
  const d1List =
    (await cf.d1.database.list({ account_id: accountId })).result ?? [];
  s.stop();

  const availableD1List = d1List.filter((d1) => d1.name || d1.uuid) as {
    name: string;
    uuid: string;
  }[];

  const selectedD1DatabaseId = await p.select({
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
    p.log.info(`Created new D1 Database: ${newD1}`);
  } else {
    p.log.info(`Selected D1: ${selectedD1DatabaseId}`);
  }

  await fs.writeFile("hot-updater.config.ts", CONFIG_TEMPLATE);

  await makeEnv({
    HOT_UPDATER_CLOUDFLARE_API_TOKEN: apiToken,
    HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: accountId,
    HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME: selectedBucketName,
    HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: selectedD1DatabaseId,
  });
  p.log.success("Generated '.env' file with Cloudflare settings.");
  p.log.success(
    "Generated 'hot-updater.config.ts' file with Cloudflare settings.",
  );

  // p.note(
  //   transformTemplate(SOURCE_TEMPLATE, {
  //     source: `https://${project.id}.supabase.co/functions/v1/update-server`,
  //   }),
  // );

  p.log.message(
    `Next step: ${link(
      "https://gronxb.github.io/hot-updater/guide/getting-started/quick-start-with-cloudflare.html#step-4-add-hotupdater-to-your-project",
    )}`,
  );
  p.log.success("Done! 🎉");
};
