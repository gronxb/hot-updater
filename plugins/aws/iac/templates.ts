import {
  type BuildType,
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  type HotUpdaterConfigScaffold,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

export type AwsConfigScaffoldAuthMode =
  | { mode: "account" }
  | { mode: "local"; profile: string | null }
  | { mode: "sso"; profile: string };

const renderConfigScaffold = (
  build: BuildType,
  authMode: AwsConfigScaffoldAuthMode,
): HotUpdaterConfigScaffold => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["s3Storage"] }],
    configString: `s3Storage({
    ...awsOptions,
    bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["dynamoDB"] }],
    configString: `dynamoDB({
    ...awsOptions,
    tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE_NAME!,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  })`,
  };

  let awsOptions: string;

  switch (authMode.mode) {
    case "sso":
      awsOptions = `
const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};`.trim();
      break;
    case "local":
      awsOptions = authMode.profile
        ? `
const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromIni({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};`.trim()
        : `
const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromNodeProviderChain(),
};`.trim();
      break;
    case "account":
      awsOptions = `
const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
  },
};`.trim();
      break;
  }

  const builder = new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .setPlugins({
      imports: [{ pkg: "@hot-updater/aws", named: ["plugins"] }],
      configString: "plugins",
    })
    .setIntermediateCode(awsOptions);

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
      break;
  }

  return createHotUpdaterConfigScaffoldFromBuilder(builder);
};

/** Every way init authenticates the CLI, which only the credentials tell apart. */
const AUTH_MODES: readonly AwsConfigScaffoldAuthMode[] = [
  { mode: "account" },
  { mode: "local", profile: null },
  { mode: "local", profile: "profile" },
  { mode: "sso", profile: "profile" },
];

export const getConfigScaffold = (
  build: BuildType,
  authMode: AwsConfigScaffoldAuthMode,
): HotUpdaterConfigScaffold => {
  const scaffold = renderConfigScaffold(build, authMode);
  // A definition init wrote with other credentials is replaced, not kept.
  const replaces = AUTH_MODES.map(
    (other) => renderConfigScaffold(build, other).definition.text,
  ).filter((text) => text !== scaffold.definition.text);
  return {
    ...scaffold,
    definition: { ...scaffold.definition, replaces },
  };
};

export const getConfigTemplate = (
  build: BuildType,
  authMode: AwsConfigScaffoldAuthMode,
) => getConfigScaffold(build, authMode).text;

/**
 * The server definitions this provider's init writes, one per credential
 * mode, whatever the build, which another provider's init replaces when it
 * finds one unedited.
 */
export const serverDefinitions = (): readonly string[] =>
  AUTH_MODES.map(
    (authMode) => renderConfigScaffold("bare", authMode).definition.text,
  );
