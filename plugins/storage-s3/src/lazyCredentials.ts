import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { type Lazy, resolveLazy } from "@hot-updater/plugin-core";

type SdkCredentials = S3ClientConfig["credentials"];

/**
 * Access keys whose fields may each be a function that returns them, such
 * as `secret("<name>")` in `hot-updater.config.ts`, called on first use.
 */
export interface LazyS3Credentials {
  readonly accessKeyId: Lazy<string>;
  readonly secretAccessKey: Lazy<string>;
  readonly sessionToken?: Lazy<string>;
}

/** The credentials the AWS SDK takes, or access keys with lazy fields. */
export type S3CredentialsOption = SdkCredentials | LazyS3Credentials;

/**
 * `credentials` as the AWS SDK takes them: access keys with a lazy field
 * become a provider, which the SDK calls once, on its first request.
 */
export const toSdkCredentials = (
  credentials: S3CredentialsOption | undefined,
): SdkCredentials => {
  if (credentials === undefined || typeof credentials === "function") {
    return credentials;
  }
  const { accessKeyId, secretAccessKey, sessionToken, ...rest } = credentials;
  if (
    typeof accessKeyId !== "function" &&
    typeof secretAccessKey !== "function" &&
    typeof sessionToken !== "function"
  ) {
    return credentials as SdkCredentials;
  }
  return async () => ({
    ...rest,
    accessKeyId: await resolveLazy(accessKeyId),
    secretAccessKey: await resolveLazy(secretAccessKey),
    ...(sessionToken === undefined
      ? {}
      : { sessionToken: await resolveLazy(sessionToken) }),
  });
};
