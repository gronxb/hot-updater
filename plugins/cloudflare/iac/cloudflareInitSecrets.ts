import {
  assertInitInputs,
  CLOUDFLARE_INIT_PROVIDER,
  link,
  p,
} from "@hot-updater/cli-tools";

type CloudflareInitSecrets = {
  readonly apiToken: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly workerName: string;
};

export const inputCloudflareInitSecrets = async ({
  accountId,
  bucketName,
  apiToken,
  accessKeyId,
  secretAccessKey,
  workerName,
  nonInteractive,
}: {
  readonly accountId: string;
  readonly bucketName: string;
  readonly apiToken?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly workerName?: string;
  readonly nonInteractive?: boolean;
}): Promise<CloudflareInitSecrets> => {
  const inputDefinitions = CLOUDFLARE_INIT_PROVIDER.inputs;
  assertInitInputs({
    inputs: {
      [inputDefinitions.apiToken.envKey]: apiToken,
      [inputDefinitions.accessKeyId.envKey]: accessKeyId,
      [inputDefinitions.secretAccessKey.envKey]: secretAccessKey,
      [inputDefinitions.workerName.envKey]: workerName,
    },
    strict: nonInteractive,
  });

  if (
    nonInteractive &&
    apiToken &&
    accessKeyId &&
    secretAccessKey &&
    workerName
  ) {
    return {
      accessKeyId,
      apiToken,
      secretAccessKey,
      workerName,
    };
  }

  if (!apiToken && !nonInteractive) {
    p.log.step(
      `D1 API Token dashboard: ${link(
        `https://dash.cloudflare.com/${accountId}/api-tokens`,
      )}`,
    );
    p.log.step(
      "Required permissions: Account Read, D1 Edit, R2 Edit, Workers Scripts Edit",
    );
    p.log.step(
      "Used for bundle metadata writes and future infrastructure updates.",
    );
  }
  if (!accessKeyId || !secretAccessKey) {
    p.log.step(
      `R2 API Tokens dashboard: ${link(
        `https://dash.cloudflare.com/${accountId}/r2/api-tokens`,
      )}`,
    );
    p.log.step("Required permission: Object Read & Write");
    p.log.step(`Target bucket: ${bucketName}`);
  }

  const inputs = await p.group(
    {
      apiToken: () =>
        apiToken
          ? Promise.resolve(apiToken)
          : p.password({
              message: inputDefinitions.apiToken.prompt.message,
              validate: (value) =>
                value ? undefined : "Cloudflare API Token is required",
            }),
      accessKeyId: () =>
        accessKeyId
          ? Promise.resolve(accessKeyId)
          : p.password({
              message: inputDefinitions.accessKeyId.prompt.message,
              validate: (value) =>
                value ? undefined : "R2 Access Key ID is required",
            }),
      secretAccessKey: () =>
        secretAccessKey
          ? Promise.resolve(secretAccessKey)
          : p.password({
              message: inputDefinitions.secretAccessKey.prompt.message,
              validate: (value) =>
                value ? undefined : "R2 Secret Access Key is required",
            }),
      workerName: () =>
        workerName
          ? Promise.resolve(workerName)
          : p.text({
              message: inputDefinitions.workerName.prompt.message,
              defaultValue: inputDefinitions.workerName.prompt.defaultValue,
              placeholder: inputDefinitions.workerName.prompt.placeholder,
              validate: (value) =>
                value ? undefined : "Worker name is required",
            }),
    },
    {
      onCancel: () => process.exit(1),
    },
  );

  return inputs;
};
