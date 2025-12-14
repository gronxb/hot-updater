import {
  type BuildType,
  ConfigBuilder,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

export const getConfigTemplate = (
  build: BuildType,
  {
    profile,
  }: {
    profile: string | null;
  },
) => {
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

  let intermediate = "";

  if (profile) {
    // SSO mode: use fromSSO with profile
    intermediate = `
const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: fromSSO({ profile: process.env.HOT_UPDATER_AWS_PROFILE! }),
};`.trim();
  } else {
    // Account mode: use access key credentials
    intermediate = `
const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
  },
};`.trim();
  }

  const builder = new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig);

  if (profile) {
    builder.addImport({
      pkg: "@aws-sdk/credential-provider-sso",
      named: ["fromSSO"],
    });
  }

  return builder.setIntermediateCode(intermediate).getResult();
};

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
