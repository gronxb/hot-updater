import type {
  Bundle,
  DatabaseClient,
  DatabaseMutationClient,
} from "@hot-updater/plugin-core";

export class AtomicDeploymentUnsupportedError extends Error {
  override readonly name = "AtomicDeploymentUnsupportedError";

  constructor(readonly bundleCount: number) {
    super(
      `Deploying ${bundleCount} bundles requires a database provider with transaction support.`,
    );
  }
}

export const prepareAndCommitBundles = async <TResult>({
  database,
  prepare,
}: {
  readonly database: DatabaseClient;
  readonly prepare: (
    persistBundle: DatabaseMutationClient["insertBundle"],
  ) => Promise<readonly TResult[]>;
}): Promise<readonly TResult[]> => {
  const preparedBundles: Bundle[] = [];
  const results = await prepare(async (bundle) => {
    preparedBundles.push(bundle);
  });

  // Uploaded content-addressed objects intentionally remain reusable when
  // the database transaction fails; shared assets must not be deleted.
  const commit = async (mutationDatabase: DatabaseMutationClient) => {
    for (const bundle of preparedBundles) {
      await mutationDatabase.insertBundle(bundle);
    }
  };

  if (preparedBundles.length > 1) {
    if (!database.mutateAtomic) {
      throw new AtomicDeploymentUnsupportedError(preparedBundles.length);
    }
    await database.mutateAtomic(commit);
  } else {
    await database.mutate(commit);
  }

  return results;
};
