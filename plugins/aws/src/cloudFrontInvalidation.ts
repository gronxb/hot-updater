import {
  CloudFrontClient,
  type CloudFrontClientConfig,
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

/** The CloudFront parts of the DynamoDB plugin's config. */
export interface UpdateRouteInvalidationConfig extends Pick<
  CloudFrontClientConfig,
  "credentials" | "region"
> {
  /** The update-check routes' base path (default `/release-catalogs`). */
  readonly apiBasePath?: string;
  readonly cloudfrontDistributionId?: string;
  readonly shouldWaitForInvalidation?: boolean;
}

/**
 * The update-check routes' CloudFront invalidation: `invalidate` purges their
 * cached copies and `destroy` releases the client; undefined without a
 * distribution. A failed invalidation only warns, so the write that changed
 * the routes still succeeds.
 */
export const createUpdateRouteInvalidation = ({
  apiBasePath = "/release-catalogs",
  cloudfrontDistributionId,
  shouldWaitForInvalidation = false,
  credentials,
  region,
}: UpdateRouteInvalidationConfig) => {
  if (!cloudfrontDistributionId) return undefined;
  const client = new CloudFrontClient({ credentials, region });
  return {
    invalidate: async () => {
      try {
        await invalidateCloudFront(
          client,
          cloudfrontDistributionId,
          [`${apiBasePath.replace(/\/+$/, "")}/*`],
          { shouldWait: shouldWaitForInvalidation },
        );
      } catch (error) {
        console.warn(
          "[hot-updater/aws] CloudFront invalidation failed; continuing without cache invalidation.",
          {
            distributionId: cloudfrontDistributionId,
            error: error instanceof Error ? error.message : "Unknown error",
          },
        );
      }
    },
    destroy: () => client.destroy(),
  };
};
