import type { InitProviderDefinition } from "../initProvider";

export const CLOUDFLARE_INIT_PROVIDER = {
  label: "Cloudflare D1 + R2 + Worker",
  inputs: {
    accountId: {
      envKey: "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID",
      help: "Cloudflare account ID",
      prompt: {
        message: "Account List",
        type: "select",
      },
    },
    apiToken: {
      envKey: "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
      help: "API token with Account, D1, R2, and Workers edit permissions",
      persistence: "with-consent",
      prompt: {
        message: "Enter the Cloudflare API Token",
        type: "password",
      },
    },
    bucketName: {
      envKey: "HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME",
      help: "R2 bucket name",
      prompt: {
        message: "Enter the name of the new R2 Bucket",
        type: "text",
      },
    },
    accessKeyId: {
      envKey: "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
      help: "R2 access key ID",
      persistence: "with-consent",
      prompt: {
        message: "Enter the R2 Access Key ID",
        type: "password",
      },
    },
    secretAccessKey: {
      envKey: "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
      help: "R2 secret access key",
      persistence: "with-consent",
      prompt: {
        message: "Enter the R2 Secret Access Key",
        type: "password",
      },
    },
    workerName: {
      envKey: "HOT_UPDATER_CLOUDFLARE_WORKER_NAME",
      help: "Worker name",
      prompt: {
        defaultValue: "hot-updater",
        message: "Enter the name of the worker",
        placeholder: "hot-updater",
        type: "text",
      },
    },
    d1DatabaseId: {
      envKey: "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID",
      help: "D1 database ID",
    },
    d1DatabaseName: {
      envKey: "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_NAME",
      help: "D1 database name",
      prompt: {
        message: "Enter the name of the new D1 Database",
        type: "text",
      },
    },
    r2Private: {
      envKey: "HOT_UPDATER_CLOUDFLARE_R2_PRIVATE",
      help: "Whether the R2 bucket is private (true or false)",
      prompt: {
        message: "Make R2 bucket private?",
        type: "confirm",
      },
      validate: (value) => value === "true" || value === "false",
    },
  },
} as const satisfies InitProviderDefinition;
