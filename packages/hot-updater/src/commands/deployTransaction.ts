import type {
  BundleDeployment,
  HotUpdaterCoreApi,
  ReleaseCatalogMutationResult,
} from "@hot-updater/plugin-core";

/** A new bundle and the release that publishes it, as core deploys them. */
export type DeploymentWrite = BundleDeployment;
export type { DeployReleasePolicy } from "@hot-updater/plugin-core";

/**
 * Deploys bundles through core: each bundle, its patches, and its release,
 * with the next catalog of each scope, in one transaction. The release id is
 * assigned after the scope's newest one, so concurrent deploys retry inside
 * core instead of here.
 */
export const commitDeployments = ({
  core,
  deployments,
}: {
  readonly core: HotUpdaterCoreApi;
  readonly deployments: readonly DeploymentWrite[];
}): Promise<readonly ReleaseCatalogMutationResult[]> =>
  core.deploy(deployments);

export const commitDeployment = async ({
  core,
  ...deployment
}: DeploymentWrite & {
  readonly core: HotUpdaterCoreApi;
}): Promise<ReleaseCatalogMutationResult> => {
  const [result] = await core.deploy([deployment]);
  return result!;
};

/** Prepares every deployment (builds and uploads), then deploys them together. */
export const prepareAndCommitBundles = async <TResult>({
  core,
  prepare,
}: {
  readonly core: HotUpdaterCoreApi;
  readonly prepare: (
    persistDeployment: (input: DeploymentWrite) => Promise<void>,
  ) => Promise<readonly TResult[]>;
}): Promise<{
  readonly commitResults: readonly ReleaseCatalogMutationResult[];
  readonly results: readonly TResult[];
}> => {
  const prepared: DeploymentWrite[] = [];
  const results = await prepare(async (input) => {
    prepared.push(input);
  });

  // Uploaded content-addressed objects intentionally remain reusable when
  // the database transaction fails; shared assets must not be deleted.
  const commitResults = await core.deploy(prepared);

  return { commitResults, results };
};
