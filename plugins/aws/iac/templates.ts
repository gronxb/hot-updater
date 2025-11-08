import {
  type BuildType,
  ConfigBuilder,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

export const getConfigTemplate = (
  build: BuildType,
  {
    sessionToken,
  }: {
    sessionToken?: boolean;
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

  if (sessionToken) {
    intermediate = `
const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
    // This token may expire. For permanent use, it's recommended to use a key with S3FullAccess and CloudFrontFullAccess permission and remove this field.
    sessionToken: process.env.HOT_UPDATER_S3_SESSION_TOKEN!,
  },
};`.trim();
  } else {
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

  return new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .setIntermediateCode(intermediate)
    .getResult();
};

export const SOURCE_TEMPLATE = `// Add this to your App.tsx
import { HotUpdater, getUpdateSource } from "@hot-updater/react-native";

function App() {
  return ...;
}

export default HotUpdater.wrap({
  source: getUpdateSource("%%source%%", {
    updateStrategy: "appVersion", // or "fingerprint"
  }),
})(App);`;
