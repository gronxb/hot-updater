import { s3Storage } from '@hot-updater/aws';
import { bare } from '@hot-updater/bare';
import { standaloneRepository } from '@hot-updater/standalone';
import { config } from 'dotenv';
import { defineConfig } from 'hot-updater';

config({ path: '.env.hotupdater' });

export default defineConfig({
  nativeBuild: { android: { aab: false } },

  build: bare({ enableHermes: true }),
  storage: s3Storage({
    bucketName: process.env.HOT_UPDATER_S3_BUCKET_NAME!,
    region: process.env.HOT_UPDATER_S3_REGION!,
    credentials: {
      accessKeyId: process.env.HOT_UPDATER_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.HOT_UPDATER_S3_SECRET_ACCESS_KEY!,
      // This token may expire. For permanent use, it's recommended to use a key with S3FullAccess and CloudFrontFullAccess permission and remove this field.
      sessionToken: process.env.HOT_UPDATER_S3_SESSION_TOKEN!,
    },
  }),
  database: standaloneRepository({
    baseUrl:
      process.env.HOT_UPDATER_SERVER_URL || 'http://localhost:3000/hot-updater',
  }),
  fingerprint: {
    debug: true,
  },
  updateStrategy: 'appVersion',
});
