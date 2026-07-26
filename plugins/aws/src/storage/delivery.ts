import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl as getCloudFrontSignedUrl } from "@aws-sdk/cloudfront-signer";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  StoragePluginError,
  type StoragePluginImplementation,
} from "@hot-updater/plugin-core/storage";

import { mapAwsStorageError } from "./errors";
import { parseS3Uri } from "./objects";
import {
  assertS3Target,
  type S3OperationEnvironment,
} from "./operationEnvironment";

type DeliveryOperation = Pick<StoragePluginImplementation, "issueDownload">;

export const createDeliveryOperation = (
  environment: S3OperationEnvironment,
  enabled: boolean,
): DeliveryOperation | Readonly<Record<string, never>> => {
  if (!enabled) {
    return {};
  }
  return {
    async issueDownload(input) {
      assertS3Target(input.context, environment.target);
      const lease = environment.owner.acquire(input.context);
      try {
        const { key } = parseS3Uri(input.storageUri, lease.config.bucketName);
        const delivery = lease.config.delivery;
        if (delivery === undefined) {
          throw new StoragePluginError(
            "unsupported",
            "S3 download delivery is not configured.",
          );
        }
        const expires =
          input.expiresInSeconds ?? delivery.expiresInSeconds ?? 3600;
        const downloadUrl =
          delivery.type === "presigned"
            ? await getS3SignedUrl(
                lease.client,
                new GetObjectCommand({
                  Bucket: lease.config.bucketName,
                  Key: key,
                }),
                { expiresIn: expires },
              )
            : getCloudFrontSignedUrl({
                url: new URL(`/${key}`, delivery.publicBaseUrl).toString(),
                keyPairId: delivery.keyPairId,
                privateKey: delivery.privateKey,
                dateLessThan: new Date(
                  Date.now() + expires * 1000,
                ).toISOString(),
              });
        return { kind: "issued", downloadUrl };
      } catch (error) {
        if (error instanceof Error) {
          throw mapAwsStorageError(error);
        }
        throw mapAwsStorageError(error);
      } finally {
        lease.release();
      }
    },
  };
};
