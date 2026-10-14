import { HotUpdater, insights } from '@hot-updater/react-native';

import {
  HOT_UPDATER_API_KEY,
  HOT_UPDATER_APP_BASE_URL,
} from './hotUpdaterBuildConfig';

export const hotUpdater = HotUpdater.init({
  // The hot-updater-v1 Edge Function URL, or HOT_UPDATER_APP_BASE_URL from the
  // build environment or .env.hotupdater (see hot-updater-build-config.cjs).
  baseURL:
    HOT_UPDATER_APP_BASE_URL ??
    'https://your-project.supabase.co/functions/v1/hot-updater-v1',
  // The client API key the server's apiKeys() requires: HOT_UPDATER_API_KEY,
  // which `hot-updater init` writes to .env.hotupdater.
  requestHeaders: HOT_UPDATER_API_KEY
    ? { 'x-api-key': HOT_UPDATER_API_KEY }
    : undefined,
  plugins: [insights()],
});

// The React Native screen is one view inside a native host. Reload only that
// runtime instead of restarting the whole host process (the Android default).
hotUpdater.setReloadBehavior('reload');
