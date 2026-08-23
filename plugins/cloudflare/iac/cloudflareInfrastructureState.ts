import {
  assertInfrastructureGenerationAtUrl,
  LegacyInfrastructureError,
} from "@hot-updater/cli-tools";

type Fetch = typeof fetch;

export type CloudflareInfrastructureState = "fresh" | "v0" | "v1";

export const resolveCloudflareInfrastructureState = (
  tableNames: readonly string[],
): CloudflareInfrastructureState => {
  if (tableNames.includes("release_catalogs")) return "v1";
  if (tableNames.includes("bundles")) return "v0";
  return "fresh";
};

export const assertCloudflareInfrastructureCanInitialize = (
  tableNames: readonly string[],
  databaseName: string,
): void => {
  if (resolveCloudflareInfrastructureState(tableNames) === "v0") {
    throw new LegacyInfrastructureError(
      "Cloudflare",
      `D1 database ${databaseName}`,
    );
  }
};

export const assertCloudflareWorkerCanInitialize = async ({
  fetchImpl,
  scriptNames,
  workerName,
  workersSubdomain,
}: {
  readonly fetchImpl?: Fetch;
  readonly scriptNames: readonly string[];
  readonly workerName: string;
  readonly workersSubdomain: string;
}): Promise<void> => {
  if (!scriptNames.includes(workerName)) return;

  await assertInfrastructureGenerationAtUrl({
    fetchImpl,
    provider: "Cloudflare",
    resource: `Worker ${workerName}`,
    versionUrl: `https://${workerName}.${workersSubdomain}.workers.dev/version`,
  });
};
