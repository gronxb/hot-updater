import {
  type BuildType,
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  type HotUpdaterConfigScaffold,
  type ManagedHelperStatement,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

export type AwsConfigScaffoldAuthMode =
  | { mode: "account" }
  | { mode: "local"; profile: string | null }
  | { mode: "sso"; profile: string };

/** The AWS resources init set up, which the config names as they are. */
export interface AwsConfigResources {
  readonly region: string;
  readonly bucketName: string;
  readonly tableName: string;
  readonly cloudfrontDistributionId: string;
}

/**
 * The config init writes. With the `resources` init set up, it names them,
 * and an account's access keys are read with `secret()`, from the
 * environment and `.env.hotupdater`, then the config's `secrets` adapter.
 * Without them, as the agent scaffold writes it, it reads every value from
 * the environment. A profile or SSO sign-in is each person's own.
 */
export const getConfigScaffold = (
  build: BuildType,
  authMode: AwsConfigScaffoldAuthMode,
  resources?: AwsConfigResources,
): HotUpdaterConfigScaffold => {
  const value = (envKey: string, resolved: string | undefined) =>
    resolved === undefined
      ? `process.env.${envKey}!`
      : JSON.stringify(resolved);
  const region = value("HOT_UPDATER_S3_REGION", resources?.region);
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["s3Storage"] }],
    configString: `s3Storage({
    ...awsOptions,
    bucketName: ${value("HOT_UPDATER_S3_BUCKET_NAME", resources?.bucketName)},
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["dynamoDB"] }],
    configString: `dynamoDB({
    ...awsOptions,
    tableName: ${value("HOT_UPDATER_DYNAMODB_TABLE_NAME", resources?.tableName)},
    cloudfrontDistributionId: ${value("HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID", resources?.cloudfrontDistributionId)},
  })`,
  };

  let helperStatements: ManagedHelperStatement[];

  switch (authMode.mode) {
    case "sso":
      helperStatements = [
        {
          name: "awsOptions",
          strategy: "merge-object",
          replaceIncompatibleProperties: ["credentials"],
          code: `
const awsOptions = {
  region: ${region},
  credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};`.trim(),
        },
      ];
      break;
    case "local":
      helperStatements = [
        {
          name: "awsOptions",
          strategy: "merge-object",
          replaceIncompatibleProperties: ["credentials"],
          code: authMode.profile
            ? `
const awsOptions = {
  region: ${region},
  credentials: fromIni({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};`.trim()
            : `
const awsOptions = {
  region: ${region},
  credentials: fromNodeProviderChain(),
};`.trim(),
        },
      ];
      break;
    case "account":
      helperStatements = [
        {
          name: "awsOptions",
          strategy: "merge-object",
          replaceIncompatibleProperties: ["credentials"],
          code:
            resources === undefined
              ? `
const awsOptions = {
  region: ${region},
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
  },
};`.trim()
              : `
const awsOptions = {
  region: ${region},
  credentials: {
    accessKeyId: secret("HOT_UPDATER_S3_ACCESS_KEY_ID"),
    secretAccessKey: secret("HOT_UPDATER_S3_SECRET_ACCESS_KEY"),
  },
};`.trim(),
        },
      ];
      break;
  }

  const builder = new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .setPlugins({
      imports: [
        {
          pkg: "hot-updater/plugins",
          named: ["apiKeys", "insights", "remoteConfig"],
        },
      ],
      configString: "[apiKeys(), insights(), remoteConfig()]",
    })
    .setIntermediateCode(
      helperStatements.map((statement) => statement.code.trim()).join("\n\n"),
    );

  switch (authMode.mode) {
    case "sso":
      builder.addImport({
        pkg: "@aws-sdk/credential-provider-sso",
        named: ["fromSSO"],
      });
      break;
    case "local":
      builder.addImport({
        pkg: "@aws-sdk/credential-providers",
        named: [authMode.profile ? "fromIni" : "fromNodeProviderChain"],
      });
      break;
    case "account":
      if (resources !== undefined) {
        builder.addImport({ pkg: "hot-updater", named: ["secret"] });
      }
      break;
  }

  return createHotUpdaterConfigScaffoldFromBuilder(builder, {
    helperStatements,
  });
};

export const getConfigTemplate = (
  build: BuildType,
  authMode: AwsConfigScaffoldAuthMode,
  resources?: AwsConfigResources,
) => getConfigScaffold(build, authMode, resources).text;
