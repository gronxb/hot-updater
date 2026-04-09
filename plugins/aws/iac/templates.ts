import {
  type BuildType,
  createHotUpdaterConfigScaffold,
  type HotUpdaterConfigScaffold,
  type ManagedHelperStatement,
  type ProviderConfig,
} from "@hot-updater/cli-tools";

export const getConfigScaffold = (
  build: BuildType,
  {
    profile,
  }: {
    profile: string | null;
  },
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

  let helperStatements: ManagedHelperStatement[] = [];

  if (profile) {
    // SSO mode: use fromSSO with profile
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
  } else {
    // Account mode: use access key credentials
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
  }

  return createHotUpdaterConfigScaffold({
    build,
    storage: storageConfig,
    database: databaseConfig,
    helperStatements,
    extraImports: profile
      ? [
          {
            pkg: "@aws-sdk/credential-provider-sso",
            named: ["fromSSO"],
          },
        ]
      : [],
  });
};

export const getConfigTemplate = (
  build: BuildType,
  {
    profile,
  }: {
    profile: string | null;
  },
) => getConfigScaffold(build, { profile }).text;

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
