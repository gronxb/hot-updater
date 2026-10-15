import { HotUpdater, insights } from '@hot-updater/react-native';

import { HOT_UPDATER_API_KEY, HOT_UPDATER_APP_BASE_URL } from '@env';

export const hotUpdater = HotUpdater.init({
  // The Edge Function URL: HOT_UPDATER_APP_BASE_URL from .env.hotupdater,
  // inlined at bundle time by react-native-dotenv (see babel.config.js).
  baseURL: HOT_UPDATER_APP_BASE_URL!,
  // The client API key the server's apiKeys() requires: HOT_UPDATER_API_KEY,
  // which `hot-updater init` writes to .env.hotupdater.
  requestHeaders: HOT_UPDATER_API_KEY
    ? { 'x-api-key': HOT_UPDATER_API_KEY }
    : undefined,
  plugins: [insights()],
});

// The React Native screen is one view inside a native host. Reload only that
// runtime instead of restarting the whole host process (the Android default).
// On Android, ReactNativeHostManager recreates the host's activity after the
// reload so the new bundle renders into a new surface.
hotUpdater.setReloadBehavior('reload');
