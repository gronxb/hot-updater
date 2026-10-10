// Not the package index: it loads Node-only helpers workerd lacks.
import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import { env } from "cloudflare:test";

import { r2Storage } from "../../src/worker";

/** Deletes every object below `basePath` from the R2 binding. */
const deleteBelow = async (basePath: string) => {
  let cursor: string | undefined;
  do {
    const listed = await env.BUCKET.list({ prefix: `${basePath}/`, cursor });
    if (listed.objects.length > 0) {
      await env.BUCKET.delete(listed.objects.map(({ key }) => key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
};

/**
 * The worker's `r2Storage` on the R2 binding, each case below a base path
 * of its own.
 */
setupStorageAdapterTestSuite({
  name: "r2Storage (workerd)",
  createStorage: async () => {
    const basePath = `conformance/${crypto.randomUUID()}`;
    return {
      storage: r2Storage({
        basePath,
        bucket: env.BUCKET,
        bucketName: env.BUCKET_NAME,
        accountId: env.ACCOUNT_ID,
        credentials: {
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
      }),
      basePath,
      cleanup: () => deleteBelow(basePath),
    };
  },
  operations: ["put", "get", "getDownloadUrl", "exists", "delete"],
});
