import { S3Client } from "@aws-sdk/client-s3";
import type { StorageOperationContext } from "@hot-updater/plugin-core/storage";

import { hasTaggedS3Options, resolveS3Config } from "./config";
import type { ResolvedS3StorageConfig, S3StorageConfig } from "./types";

export type S3ClientLease = Readonly<{
  client: S3Client;
  config: ResolvedS3StorageConfig;
  release: () => void;
}>;

const createClient = (config: ResolvedS3StorageConfig): S3Client =>
  new S3Client({
    ...(config.region === undefined ? {} : { region: config.region }),
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.credentials === undefined
      ? {}
      : { credentials: config.credentials }),
    ...(config.forcePathStyle === undefined
      ? config.endpoint === undefined
        ? {}
        : { forcePathStyle: true }
      : { forcePathStyle: config.forcePathStyle }),
    ...(config.maxAttempts === undefined
      ? {}
      : { maxAttempts: config.maxAttempts }),
    ...(config.requestChecksumCalculation === undefined
      ? {}
      : { requestChecksumCalculation: config.requestChecksumCalculation }),
    ...(config.responseChecksumValidation === undefined
      ? {}
      : { responseChecksumValidation: config.responseChecksumValidation }),
  });

export const createS3ClientOwner = (config: S3StorageConfig) => {
  const scoped = hasTaggedS3Options(config);
  let cachedClient: S3Client | undefined;
  let cleanup: Promise<void> | undefined;

  return {
    acquire(context: StorageOperationContext): S3ClientLease {
      const resolved = resolveS3Config(config, context);
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
