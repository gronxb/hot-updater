import {
  assertInitInputs,
  getHotUpdaterEnvValue,
} from "@hot-updater/cli-tools";

export type CloudflareInitInputs = {
  readonly accessKeyId?: string;
  readonly accountId?: string;
  readonly apiToken?: string;
  readonly bucketName?: string;
  readonly d1DatabaseId?: string;
  readonly r2Private?: string;
  readonly secretAccessKey?: string;
  readonly workerName?: string;
};

export const resolveCloudflareInitInputs = (
  existingEnv: Readonly<Record<string, string>>,
): CloudflareInitInputs => {
  const apiTokenKey = "HOT_UPDATER_CLOUDFLARE_API_TOKEN";

  return {
    accessKeyId: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID",
    ),
    accountId: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID",
    ),
    apiToken:
      process.env[apiTokenKey]?.trim() ??
      (Object.hasOwn(existingEnv, apiTokenKey)
        ? existingEnv[apiTokenKey]
        : undefined),
    bucketName: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME",
    ),
    d1DatabaseId: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID",
    ),
    r2Private: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_CLOUDFLARE_R2_PRIVATE",
    ),
    secretAccessKey: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY",
    ),
    workerName: getHotUpdaterEnvValue(
      existingEnv,
      "HOT_UPDATER_CLOUDFLARE_WORKER_NAME",
    ),
  };
};

export const assertCloudflareNonInteractiveInputs = (
  inputs: CloudflareInitInputs,
  nonInteractive: boolean,
): void => {
  assertInitInputs({
    inputs: {
      HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: inputs.accountId,
      HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME: inputs.bucketName,
      HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID: inputs.accessKeyId,
      HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY: inputs.secretAccessKey,
      HOT_UPDATER_CLOUDFLARE_WORKER_NAME: inputs.workerName,
      HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: inputs.d1DatabaseId,
      HOT_UPDATER_CLOUDFLARE_R2_PRIVATE:
        inputs.r2Private === "true" || inputs.r2Private === "false"
          ? inputs.r2Private
          : undefined,
    },
    strict: nonInteractive,
  });
};
