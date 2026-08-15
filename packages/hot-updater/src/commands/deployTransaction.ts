import type {
  Bundle,
  DatabaseClient,
  DatabaseMutationClient,
} from "@hot-updater/plugin-core";

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

  await database.mutate(commit);

  return results;
};
