import { bare } from '@hot-updater/bare';
import { standaloneRepository } from '@hot-updater/standalone';
import { supabaseStorage } from '@hot-updater/supabase';
import { config } from 'dotenv';
import { defineConfig } from 'hot-updater';

config({ path: '.env.hotupdater' });

export default defineConfig({
  nativeBuild: { android: { aab: false } },

  build: bare({ enableHermes: true }),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
    basePath: '0-81-0',
  }),
  database: standaloneRepository({
    baseUrl:
      process.env.HOT_UPDATER_SERVER_URL || 'http://localhost:3000/hot-updater',
  }),
  fingerprint: {
    debug: true,
  },
  updateStrategy: 'appVersion',
  compressStrategy: 'tar.br',
});
