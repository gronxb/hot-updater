import type { InitProviderDefinition } from "../initProvider";

export const AWS_INIT_PROVIDER = {
  label: "AWS S3 + Lambda@Edge",
  inputs: {
    authMode: {
      envKey: "HOT_UPDATER_AWS_AUTH_MODE",
      help: "AWS authentication mode: local-session, shared-profile, sso, or account",
      prompt: {
        message: "Select the mode to login to AWS",
        type: "select",
      },
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
      prompt: {
        message:
          "Apply pending Hot Updater S3 migrations during init and future infrastructure updates?",
        type: "confirm",
      },
      validate: (value) => value === "true",
    },
  },
} as const satisfies InitProviderDefinition;
