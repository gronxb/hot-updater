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
): HotUpdaterConfigScaffold => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["s3Storage"] }],
    configString: "s3Storage(commonOptions)",
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/aws", named: ["s3Database"] }],
    configString: `s3Database({
    ...commonOptions,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  })`,
  };

  let helperStatements: ManagedHelperStatement[];

  switch (authMode.mode) {
    case "sso":
      helperStatements = [
        {
          name: "commonOptions",
          strategy: "merge-object",
          code: `
const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};`.trim(),
        },
      ];
      break;
    case "local":
      helperStatements = [
        {
          name: "commonOptions",
          strategy: "merge-object",
          code: authMode.profile
            ? `
const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromIni({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};`.trim()
            : `
const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromNodeProviderChain(),
};`.trim(),
        },
      ];
      break;
    case "account":
      helperStatements = [
        {
          name: "commonOptions",
          strategy: "merge-object",
          code: `
const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
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
  });
};

export const getConfigTemplate = (
  build: BuildType,
  authMode: AwsConfigScaffoldAuthMode,
) => getConfigScaffold(build, authMode).text;

export const SOURCE_TEMPLATE = `// Add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return ...;
}

export default HotUpdater.wrap({
  baseURL: "%%source%%",
  updateStrategy: "appVersion", // or "fingerprint"
  updateMode: "auto",
})(App);`;
