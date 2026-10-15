import { existsSync } from 'node:fs';
import { rock } from '@hot-updater/rock';
import { supabaseDatabase, supabaseStorage } from '@hot-updater/supabase';
import { defineConfig } from 'hot-updater';
import { apiKeys, insights, remoteConfig } from 'hot-updater/plugins';

// Provider credentials for the CLI (deploy, fingerprint, channel, console).
// `hot-updater init` writes them here; the file is gitignored. Of its keys,
// only the ones src/hotUpdater.ts imports from '@env' reach the app bundle
// (see babel.config.js).
if (existsSync('.env.hotupdater')) {
  process.loadEnvFile('.env.hotupdater');
}

export default defineConfig({
  build: rock(),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
  }),
  plugins: [apiKeys(), insights(), remoteConfig()],
  // The fingerprint strategy ties an OTA bundle to the native code of the
  // packaged artifact rather than to the host app's version: the hosts can
  // ship new versions of their own without invalidating the bundle.
  updateStrategy: 'fingerprint',
  // Brownfield: the CLI must write the fingerprint hash and channel into the
  // files that ship inside the AAR and the XCFramework, not into the
  // standalone app in android/app and ios/RnBrownfield. The library manifest
  // is merged into the host's manifest, where the Android SDK reads it; the
  // framework's Info.plist is read by RnBrownfieldReact.swift, which hands the
  // values to the iOS SDK.
  platform: {
    android: {
      androidManifestPaths: [
        'android/rnbrownfieldreact/src/main/AndroidManifest.xml',
      ],
    },
    ios: {
      infoPlistPaths: ['ios/RnBrownfieldReact/Info.plist'],
    },
  },
});
