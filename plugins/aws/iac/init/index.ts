import type { InitProviderDefinition } from "@hot-updater/cli-tools";

export const AWS_AUTH_MODES = [
  "local-session",
  "shared-profile",
  "sso",
  "account",
] as const;

export type AwsAuthMode = (typeof AWS_AUTH_MODES)[number];

export const isAwsAuthMode = (
  value: string | undefined,
): value is AwsAuthMode =>
  value !== undefined && AWS_AUTH_MODES.some((mode) => mode === value);

export const AWS_REGION_VALUES = [
  "af-south-1",
  "ap-east-1",
  "ap-east-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "ca-central-1",
  "ca-west-1",
  "cn-north-1",
  "cn-northwest-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "mx-central-1",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-gov-east-1",
  "us-gov-west-1",
  "us-west-1",
  "us-west-2",
] as const;

export type AwsRegionValue = (typeof AWS_REGION_VALUES)[number];

export const isAwsRegionValue = (
  value: string | undefined,
): value is AwsRegionValue =>
  value !== undefined && AWS_REGION_VALUES.some((region) => region === value);

export const initProvider = {
  label: "AWS S3 + Lambda@Edge",
  inputs: {
    authMode: {
      envKey: "HOT_UPDATER_AWS_AUTH_MODE",
      help: "AWS authentication mode: local-session, shared-profile, sso, or account",
      prompt: {
        message: "Select the mode to login to AWS",
        type: "select",
      },
      validate: isAwsAuthMode,
    },
    profile: {
      envKey: "HOT_UPDATER_AWS_PROFILE",
      help: "AWS profile name",
      requiredWhen: (inputs) =>
        inputs.authMode === "shared-profile" || inputs.authMode === "sso",
      requirementHint: "required for shared-profile and sso auth",
      prompt: {
        defaultValue: "default",
        message: "Enter the AWS profile name",
        placeholder: "default",
        type: "text",
      },
    },
    accessKeyId: {
      envKey: "HOT_UPDATER_S3_ACCESS_KEY_ID",
      help: "AWS access key ID",
      persistence: "with-consent",
      requiredWhen: (inputs) => inputs.authMode === "account",
      requirementHint: "required for account auth",
      prompt: {
        message: "Enter your AWS Access Key ID",
        placeholder: "AKIA...",
        type: "text",
      },
    },
    secretAccessKey: {
      envKey: "HOT_UPDATER_S3_SECRET_ACCESS_KEY",
      help: "AWS secret access key",
      persistence: "with-consent",
      requiredWhen: (inputs) => inputs.authMode === "account",
      requirementHint: "required for account auth",
      prompt: {
        message: "Enter your AWS Secret Access Key",
        type: "password",
      },
    },
    bucketName: {
      envKey: "HOT_UPDATER_S3_BUCKET_NAME",
      help: "S3 bucket name",
      prompt: {
        defaultValue: "hot-updater-storage",
        message: "Enter the name of the new S3 Bucket",
        placeholder: "hot-updater-storage",
        type: "text",
      },
    },
    bucketRegion: {
      envKey: "HOT_UPDATER_S3_REGION",
      help: "S3 bucket region",
      prompt: {
        message: "Enter AWS region for the S3 bucket",
        type: "select",
      },
      validate: isAwsRegionValue,
    },
    lambdaName: {
      envKey: "HOT_UPDATER_AWS_LAMBDA_NAME",
      help: "Lambda@Edge function name",
      prompt: {
        defaultValue: "hot-updater-edge",
        message: "Enter the name of the Lambda@Edge function",
        placeholder: "hot-updater-edge",
        type: "text",
      },
    },
    distributionId: {
      envKey: "HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID",
      help: "Existing CloudFront distribution ID",
      optional: true,
    },
    migrationApproved: {
      envKey: "HOT_UPDATER_AWS_MIGRATION_APPROVED",
      help: "Allow pending Hot Updater S3 migrations (true)",
      optional: true,
      prompt: {
        message:
          "Apply pending Hot Updater S3 migrations during init and future infrastructure updates?",
        type: "confirm",
      },
      validate: (value) => value === "true",
    },
  },
} as const satisfies InitProviderDefinition;
