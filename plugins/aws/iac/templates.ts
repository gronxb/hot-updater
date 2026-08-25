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

export const getConfigScaffold = (
  build: BuildType,
  authMode: AwsConfigScaffoldAuthMode,
  authorityId?: string,
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
  region: process.env.HOT_UPDATER_S3_REGION!,
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
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromIni({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};`.trim()
            : `
const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
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
          code: `
const awsOptions = {
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
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
      break;
  }

  return createHotUpdaterConfigScaffoldFromBuilder(builder, {
    helperStatements,
    ...(authorityId
      ? { authorityIdInitializer: JSON.stringify(authorityId) }
      : {}),
  });
};

export const getConfigTemplate = (
  build: BuildType,
  authMode: AwsConfigScaffoldAuthMode,
) => getConfigScaffold(build, authMode).text;

export const SOURCE_TEMPLATE = `// Add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return null; // Replace with your app root.
}

HotUpdater.init({
  baseURL: %%source%%,
  requestHeaders: {
    "x-api-key": %%apiKey%%,
  },
});

// Call HotUpdater.checkForUpdate({ updateStrategy: "appVersion" })
// when your app is ready to check.
export default App;`;
