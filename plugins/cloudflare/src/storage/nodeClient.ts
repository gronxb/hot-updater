import { S3Client } from "@aws-sdk/client-s3";
import type { StorageOperationContext } from "@hot-updater/plugin-core/storage";

import { hasTaggedR2NodeOptions, resolveR2NodeConfig } from "./nodeConfig";
import type {
  R2NodeStorageConfig,
  ResolvedR2NodeStorageConfig,
} from "./nodeTypes";

export type R2ClientLease = Readonly<{
  client: S3Client;
  config: ResolvedR2NodeStorageConfig;
  release: () => void;
}>;

const createClient = (config: ResolvedR2NodeStorageConfig): S3Client =>
  new S3Client({
    credentials: config.credentials,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    region: config.region,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

export const createR2ClientOwner = (config: R2NodeStorageConfig) => {
  const scoped = hasTaggedR2NodeOptions(config);
  let cachedClient: S3Client | undefined;
  let cleanup: Promise<void> | undefined;

  return {
    acquire(context: StorageOperationContext): R2ClientLease {
      const resolved = resolveR2NodeConfig(config, context);
      const client = scoped
        ? createClient(resolved)
        : (cachedClient ??= createClient(resolved));
      let released = false;
      return {
        client,
        config: resolved,
        release() {
          if (released) {
            return;
          }
          released = true;
          if (scoped) {
            client.destroy();
          }
        },
      };
    },
    onUnmount(): Promise<void> {
      cleanup ??= Promise.resolve().then(() => {
        cachedClient?.destroy();
      });
      return cleanup;
    },
  };
};
