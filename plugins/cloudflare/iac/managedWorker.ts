import fs from "fs/promises";
import path from "path";

/**
 * Readies the staged prebuilt Worker for Wrangler as init deploys it: its
 * bindings to the D1 database and R2 bucket, and the bucket's name and the
 * account's ID, which the Worker reads from its vars to presign R2 URLs.
 */
export const prepareWorkerDeployment = async (
  workerRoot: string,
  {
    accountId,
    d1DatabaseId,
    d1DatabaseName,
    r2BucketName,
  }: {
    accountId: string;
    d1DatabaseId: string;
    d1DatabaseName: string;
    r2BucketName: string;
  },
) => {
  const configPath = path.join(workerRoot, "wrangler.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  config.d1_databases = [
    {
      binding: "DB",
      database_id: d1DatabaseId,
      database_name: d1DatabaseName,
    },
  ];
  config.r2_buckets = [{ binding: "BUCKET", bucket_name: r2BucketName }];
  config.vars = { ACCOUNT_ID: accountId, BUCKET_NAME: r2BucketName };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
};
