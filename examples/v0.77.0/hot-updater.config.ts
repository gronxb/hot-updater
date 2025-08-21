import {bare} from '@hot-updater/bare';
import {supabaseDatabase, supabaseStorage} from '@hot-updater/supabase';
import 'dotenv/config';
import {defineConfig} from 'hot-updater';

export default defineConfig({
  nativeBuild: {
    android: {
      releaseApk: {packageName: 'com.hotupdaterexample', aab: false},
      releaseAab: {packageName: 'com.hotupdaterexample', aab: true},
    },
    ios: {
      release: {
        scheme: 'HotUpdaterExample',
        buildConfiguration: 'Release',
        archive: false,
        installPods: false,
        // exportOptionsPlist: "./ios/HotUpdaterExample/ExportOptions.plist",
      },
      // debug: {
      //   scheme: "Debug",
      //   exportOptionsPlist: "./ios/HotUpdaterExample/ExportOptions.plist",
      // },
    },
  },
  build: bare({enableHermes: true}),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
  }),
});
