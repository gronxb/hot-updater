import { s3Storage } from '@hot-updater/aws';
import { r2Storage } from '@hot-updater/cloudflare';
import { firebaseStorage } from '@hot-updater/firebase';
import * as admin from 'firebase-admin';
import { bare } from '@hot-updater/bare';
import { standaloneRepository } from '@hot-updater/standalone';
import { supabaseStorage } from '@hot-updater/supabase';
import { config } from 'dotenv';
import { defineConfig } from 'hot-updater';

config({ path: '.env.hotupdater' });

const getStorage = () => {
  switch (process.env.STORAGE) {
    case 'S3':
      return s3Storage({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
        bucketName: process.env.R2_BUCKET_NAME!,
      });
    case 'R2':
      return r2Storage({
        bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
        accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
        cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
      });
    case 'FIREBASE':
      return firebaseStorage({
        projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
        storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
        credential: admin.credential.cert(
          process.env.GOOGLE_APPLICATION_CREDENTIALS!,
        ),
      });
    case 'SUPABASE':
      return supabaseStorage({
        supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
        supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
        bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
      });
    default:
      throw new Error(
        'Please STORAGE=S3|R2|FIREBASE|SUPABASE pnpm hot-updater deploy',
      );
  }
};

export default defineConfig({
  nativeBuild: { android: { aab: false } },

  build: bare({ enableHermes: true }),
  storage: getStorage(),
  database: standaloneRepository({
    baseUrl: 'http://localhost:3006/hot-updater',
  }),
  fingerprint: {
    debug: true,
  },
  updateStrategy: 'appVersion',
  compressStrategy: 'tar.br',
});
