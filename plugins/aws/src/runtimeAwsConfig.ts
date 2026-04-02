import type { S3ClientConfig } from "@aws-sdk/client-s3";
import type { SSMClientConfig } from "@aws-sdk/client-ssm";

const truthyValues = new Set(["1", "true", "yes", "on"]);

const isTruthy = (value: string | undefined) => {
  if (!value) {
    return false;
  }

  return truthyValues.has(value.toLowerCase());
};

export const getAwsEndpointUrl = () => {
  return process.env.AWS_ENDPOINT_URL?.trim() || undefined;
};

const shouldForcePathStyle = (
  forcePathStyle: boolean | undefined,
  endpoint: unknown,
) => {
  if (forcePathStyle !== undefined) {
    return forcePathStyle;
  }

  if (isTruthy(process.env.AWS_S3_FORCE_PATH_STYLE)) {
    return true;
  }

  return endpoint !== undefined;
};

export const applyS3RuntimeAwsConfig = (
  config: S3ClientConfig,
): S3ClientConfig => {
  const endpoint = config.endpoint ?? getAwsEndpointUrl();

  return {
    ...config,
    endpoint,
    forcePathStyle: shouldForcePathStyle(config.forcePathStyle, endpoint),
  };
};

export const applySsmRuntimeAwsConfig = (
  config: SSMClientConfig,
): SSMClientConfig => {
  const endpoint = config.endpoint ?? getAwsEndpointUrl();

  return {
    ...config,
    endpoint,
  };
};
