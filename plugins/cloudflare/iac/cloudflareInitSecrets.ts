import { link, p } from "@hot-updater/cli-tools";

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
}: {
  readonly accountId: string;
  readonly bucketName: string;
  readonly apiToken?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly workerName?: string;
}): Promise<CloudflareInitSecrets> => {
  if (apiToken === undefined) {
    p.log.step(
      `D1 API Token dashboard: ${link(
        `https://dash.cloudflare.com/${accountId}/api-tokens`,
      )}`,
    );
    p.log.step("Required permission: D1 Edit");
    p.log.step("Used for bundle metadata writes after init.");
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
        apiToken !== undefined
          ? Promise.resolve(apiToken)
          : p.password({
              message: "Enter the D1 API Token",
            }),
      accessKeyId: () =>
        accessKeyId
          ? Promise.resolve(accessKeyId)
          : p.password({
              message: "Enter the R2 Access Key ID",
            }),
      secretAccessKey: () =>
        secretAccessKey
          ? Promise.resolve(secretAccessKey)
          : p.password({
              message: "Enter the R2 Secret Access Key",
            }),
      workerName: () =>
        workerName
          ? Promise.resolve(workerName)
          : p.text({
              message: "Enter the name of the worker",
              defaultValue: "hot-updater",
              placeholder: "hot-updater",
            }),
    },
    {
      onCancel: () => process.exit(1),
    },
  );

  return inputs;
};
