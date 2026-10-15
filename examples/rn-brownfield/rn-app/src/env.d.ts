// The keys src/hotUpdater.ts imports from .env.hotupdater through
// react-native-dotenv (babel.config.js). Public settings only.
declare module '@env' {
  export const HOT_UPDATER_APP_BASE_URL: string | undefined;
  export const HOT_UPDATER_API_KEY: string | undefined;
}
