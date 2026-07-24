import {
  type CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

type CloudFrontInvalidationOptions = {
  readonly shouldWait: boolean;
};

export const invalidateCloudFront = async (
  client: CloudFrontClient,
  distributionId: string,
  paths: readonly string[],
  options: CloudFrontInvalidationOptions,
): Promise<void> => {
  if (paths.length === 0) return;
  const response = await client.send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: `invalidation-${Date.now()}`,
        Paths: {
          Quantity: paths.length,
          Items: paths.map((path) => encodeURI(path)),
        },
      },
    }),
  );
  if (!options.shouldWait || response.Invalidation?.Status === "Completed") {
    return;
  }
  const invalidationId = response.Invalidation?.Id;
  if (!invalidationId) {
    throw new Error(
      "CloudFront invalidation response is missing Invalidation.Id",
    );
  }
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(DEFAULT_POLL_INTERVAL_MS);
    const status = await client.send(
      new GetInvalidationCommand({
        DistributionId: distributionId,
        Id: invalidationId,
      }),
    );
    if (status.Invalidation?.Status === "Completed") return;
  }
  throw new Error(
    `Timed out waiting for CloudFront invalidation ${invalidationId}.`,
  );
};
