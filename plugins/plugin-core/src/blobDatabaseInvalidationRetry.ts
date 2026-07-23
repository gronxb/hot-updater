import { changedBundleInvalidationPaths } from "./blobDatabaseInvalidation";
import type { BlobDatabaseSnapshot } from "./blobDatabaseSnapshot";
import type { BlobDatabaseOperations } from "./createBlobDatabasePlugin";

const BLOB_DATABASE_INVALIDATION_MAX_ATTEMPTS = 3;
const BLOB_DATABASE_INVALIDATION_RETRY_BASE_DELAY_MS = 10;
const INVALIDATION_SUCCEEDED = Symbol("invalidation-succeeded");

export type BlobInvalidationFailure = {
  readonly attempts: number;
  readonly error: unknown;
  readonly paths: readonly string[];
};

const waitForInvalidationRetry = (attempt: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(
      resolve,
      Math.min(BLOB_DATABASE_INVALIDATION_RETRY_BASE_DELAY_MS * attempt, 100),
    );
  });

export const invalidateBlobPathsAfterCommit = async (
  operations: BlobDatabaseOperations,
  before: BlobDatabaseSnapshot,
  after: BlobDatabaseSnapshot,
): Promise<void> => {
  const paths = changedBundleInvalidationPaths(
    operations.apiBasePath,
    before,
    after,
  );
  for (
    let attempt = 1;
    paths.length > 0 && attempt <= BLOB_DATABASE_INVALIDATION_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const outcome: unknown = await operations.invalidatePaths(paths).then(
      () => INVALIDATION_SUCCEEDED,
      (error: unknown) => error,
    );
    if (outcome === INVALIDATION_SUCCEEDED) return;
    if (attempt < BLOB_DATABASE_INVALIDATION_MAX_ATTEMPTS) {
      await waitForInvalidationRetry(attempt);
      continue;
    }
    operations.onInvalidationError?.({
      attempts: attempt,
      error: outcome,
      paths,
    });
  }
};
