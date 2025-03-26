export const CONFIG_TEMPLATE_WITH_SESSION = `
import { metro } from "@hot-updater/metro";
import { s3Storage, s3Database } from "@hot-updater/aws";
import { defineConfig } from "hot-updater";
import "dotenv/config";

const commonOptions = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
    // This token may expire. For permanent use, it’s recommended to use a key with S3FullAccess permission and remove this field.
    sessionToken: process.env.HOT_UPDATER_S3_SESSION_TOKEN!,
  },
};

export default defineConfig({
  build: metro({ enableHermes: true }),
  storage: s3Storage(commonOptions),
  database: s3Database({
    ...commonOptions,
    cloudfrontDistributionId: process.env.HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID!,
  }),
});
`;

export const CONFIG_TEMPLATE = `
import { metro } from "@hot-updater/metro";
import { s3Storage, s3Database } from "@hot-updater/aws";
import { defineConfig } from "hot-updater";
import "dotenv/config";

const options = {
  bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
  region: process.env.HOT_UPDATER_S3_REGION!,
  credentials: {
    accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
  },
};

export default defineConfig({
  build: metro({ enableHermes: true }),
  storage: s3Storage(options),
  database: s3Database(options),
});
`;

export const SOURCE_TEMPLATE = `// Add this to your App.tsx
import { HotUpdater } from "@hot-updater/react-native";

function App() {
  return ...;
}

export default HotUpdater.wrap({
  source: "%%source%%",
})(App);`;
